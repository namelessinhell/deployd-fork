const http = require('http');
const Router = require('./router');
const db = require('./db');
const Keys = require('./keys');
// Support both shapes: module.exports = { SessionStore } and module.exports = SessionStore
const sessionModule = require('./session');
const SessionStore = sessionModule && (sessionModule.SessionStore || sessionModule);
const fs = require('fs');
const { Server: SocketIOServer } = require('socket.io'); // Updated import for Socket.IO v4
const setupReqRes = require('./util/http').setup;
const debug = require('debug')('server');
const doh = require('doh');
const config = require('./config-loader');
const _ = require('lodash');

/**
 * Utility function to extend an object with properties from another.
 * Only adds properties that are truthy.
 *
 * @param {Object} origin - The target object to be extended.
 * @param {Object} add - The source object with properties to add.
 * @return {Object} - The extended origin object.
 */
function extend(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || typeof add !== 'object') return origin;

  const keys = Object.keys(add);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (add[key]) origin[key] = add[key];
  }
  return origin;
}

/**
 * Server class that extends Node.js's built-in HTTP server.
 * Integrates Socket.IO for real-time communication and MongoDB for data storage.
 */
class Server extends http.Server {
  /**
   * Constructor for the Server class.
   *
   * @param {Object} options - Configuration options for the server.
   */
  constructor(options = {}) {
    super();
    const server = this;

    // Set default options
    server.options = extend(
      {
        port: 2403,
        host: '0.0.0.0',
        db: { port: 27017, host: '127.0.0.1', name: 'deployd' },
        socketIo: {
          cors: {
            origin: '*', // Adjust CORS as needed
            methods: ['GET', 'POST'],
          },
          // Additional Socket.IO options can be added here
        },
        env: process.env.NODE_ENV || 'development',
      },
      options
    );

    debug('Server started with options: %j', server.options);

    // Initialize stores
    server.stores = {};

    // Tune HTTP server timeouts for better throughput/keep-alive handling
    server.keepAliveTimeout = server.options.keepAliveTimeout || 65000; // keep-alive sockets
    server.headersTimeout = server.options.headersTimeout || 66000;     // headers timeout should be > keepAlive
    // 0 means use Node's default behavior; set to a higher value to accommodate slow clients if needed
    if (typeof server.options.requestTimeout === 'number') {
      server.requestTimeout = server.options.requestTimeout;
    }

    // Initialize the database connection
    server.db = db.create(server.options.db);

    // Initialize Socket.IO
    server.io = new SocketIOServer(server, {
      cors: server.options.socketIo.cors,
      ...server.options.socketIo.options, // Spread any additional Socket.IO options
    });

    // If an adapter is provided, use it (e.g., Redis adapter for scaling)
    if (server.options.socketIo.adapter) {
      server.io.adapter(server.options.socketIo.adapter);
    }

    // Persist sessions in a store
    server.sessions = new SessionStore('sessions', server.db, server.io, server.options.sessions);

    // Persist keys in a store
    server.keys = new Keys();

    // Bind the handleRequest method to the server instance
    server.on('request', server.handleRequest.bind(server));

    // Handle Socket.IO connections (optional: customize as needed)
    server.io.on('connection', (socket) => {
      debug('A client connected:', socket.id);

      // Handle custom Socket.IO events here
      socket.on('disconnect', () => {
        debug('Client disconnected:', socket.id);
      });
    });

    // Gracefully handle server shutdown
    process.on('SIGINT', () => {
      debug('Received SIGINT. Shutting down gracefully...');
      server.shutdown();
    });

    process.on('SIGTERM', () => {
      debug('Received SIGTERM. Shutting down gracefully...');
      server.shutdown();
    });
  }

  /**
   * Handles incoming HTTP requests.
   *
   * @param {http.IncomingMessage} req - The HTTP request.
   * @param {http.ServerResponse} res - The HTTP response.
   */
  async handleRequest(req, res) {
    const server = this;

    // Don't handle Socket.IO requests
    if (req.url.startsWith('/socket.io/')) return;

    debug('%s %s', req.method, req.url);

    try {
      // Add utilities to req and res (wrap callback API)
      await new Promise((resolve) => setupReqRes(server.options, req, res, resolve));

      let authToken;
      let usesBearerAuth = false;

      // Extract Bearer token if present
      if (req.headers && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        const scheme = parts[0];
        const credentials = parts[1];

        if (/^Bearer$/i.test(scheme)) {
          authToken = credentials;
          usesBearerAuth = true;
        }
      }

      // Create or retrieve the session
      server.sessions.createSession(authToken || req.cookies.get('sid'), (err, session) => {
        if (err) {
          debug('Session error:', err, session);
          const responder = doh.createResponder();
          res.statusCode = 500;
          return responder(err instanceof Error ? err : { message: 'Session error', statusCode: 500 }, req, res);
        }

        if (!usesBearerAuth && session.sid) {
          // (Re)set the session ID cookie if not using Authorization Bearer
          req.cookies.set('sid', session.sid, {
            httpOnly: true,
            secure: server.options.env === 'production',
            sameSite: 'lax',
          });
        }

        req.session = session;

        const root = req.headers['dpd-ssh-key'] || req.cookies.get('DpdSshKey');

        if (server.options.env === 'development') {
          if (root) {
            req.isRoot = true;
          }
          server.route(req, res);
        } else if (root) {
          // All root requests must be authenticated
          debug('Authenticating root request with key:', root);
          server.keys.get(root, (err, key) => {
            if (err) {
              debug('Error retrieving key:', err);
              const responder = doh.createResponder();
              res.statusCode = 500;
              return responder(err instanceof Error ? err : { message: 'Key retrieval error', statusCode: 500 }, req, res);
            }
            if (key) req.isRoot = true;
            debug('Is root:', req.isRoot);
            server.route(req, res);
          });
        } else {
          // Normal routing
          server.route(req, res);
        }
      });
    } catch (err) {
      debug('Error handling request:', err);
      const responder = doh.createResponder();
      res.statusCode = 500;
      responder(err instanceof Error ? err : { message: 'Internal Server Error', statusCode: 500 }, req, res);
    }
  }

  /**
   * Starts the server and begins listening for incoming connections.
   *
   * @param {Number} [port] - The port number to listen on.
   * @param {String} [host] - The hostname to bind to.
   * @return {Server} - Returns the server instance for chaining.
   */
  listen(port, host) {
    const server = this;
    const serverPath = server.options.server_dir || fs.realpathSync('./');

    config.loadConfig(serverPath, server, async (err, resourcesInstances) => {
      if (err) {
        console.error();
        console.error('Error loading resources:');
        console.error(err.stack || err);
        process.exit(1);
      } else {
        server.resources = resourcesInstances;
        server.router = new Router(resourcesInstances, server);
        http.Server.prototype.listen.call(
          server,
          port || server.options.port,
          host || server.options.host,
          () => {
            debug(`Server is listening on ${host || '0.0.0.0'}:${port || server.options.port}`);
          }
        );
      }
    });
    return this;
  }

  /**
   * Routes an HTTP request to the appropriate handler.
   *
   * @param {http.IncomingMessage} req - The HTTP request.
   * @param {http.ServerResponse} res - The HTTP response.
   */
  async route(req, res) {
    const server = this;
    const serverPath = server.options.server_dir || './';

    try {
      // Fast-path in non-development: reuse existing router/resources
      if (server.router && server.resources && server.options.env !== 'development') {
        return server.router.route(req, res);
      }

      const resourcesInstances = await new Promise((resolve, reject) => {
        config.loadConfig(serverPath, server, (err, resources) => {
          if (err) reject(err);
          else resolve(resources);
        });
      });

      // Cache resources/router for subsequent requests
      server.resources = resourcesInstances;
      if (!server.router || server.options.env === 'development') {
        server.router = new Router(resourcesInstances, server);
      }
      server.router.route(req, res);
    } catch (err) {
      debug('Routing error:', err);
      const responder = doh.createResponder();
      res.statusCode = err && err.statusCode || 500;
      responder(err instanceof Error ? err : { message: 'Internal Server Error', statusCode: 500 }, req, res);
    }
  }

  /**
   * Creates a new `Store` for persisting data using the database info.
   *
   * @param {String} namespace - The namespace for the store (e.g., collection name).
   * @return {Store} - Returns the created store instance.
   */
  createStore(namespace) {
    if (this.stores[namespace]) {
      debug(`Store for namespace "${namespace}" already exists.`);
      return this.stores[namespace];
    }
    const store = this.db.createStore(namespace);
    this.stores[namespace] = store;
    debug(`Created store for namespace "${namespace}".`);
    return store;
  }

  /**
   * Gracefully shuts down the server by closing database connections and Socket.IO.
   */
  async shutdown() {
    const server = this;
    try {
      debug('Shutting down server gracefully...');
      await server.db.close();
      server.io.close(() => {
        debug('Socket.IO closed.');
        process.exit(0);
      });
    } catch (err) {
      debug('Error during shutdown:', err);
      process.exit(1);
    }
  }
}

module.exports = Server;
