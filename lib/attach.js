const fs = require('fs');
const path = require('path');
const debug = require('debug')('server');
const _ = require('underscore');
const Router = require('./router');
const db = require('./db');
const { Server } = require('socket.io'); // Updated import for Socket.IO v4
const Keys = require('./keys');
const { SessionStore } = require('./session').SessionStore;
const { setupReqRes } = require('./util/http').setup;
const config = require('./config-loader');

/**
 * Attach deployd router, sessions, db, and functions to an existing HTTP server instance.
 *
 * @param {Object} httpServer - The existing HTTP server instance.
 * @param {Object} options - Configuration options.
 * @return {HttpServer}
 */
function attach(httpServer, options) {
  const server = process.server = httpServer;

  // Set default options
  server.options = options = _.extend({
    db: { port: 27017, host: '127.0.0.1', name: 'deployd' }
  }, options);

  debug('started with options %j', options);

  // Initialize stores
  server.stores = {};

  // Initialize the database connection
  server.db = db.create(options.db);

  // Initialize Socket.IO
  let io;
  if (options.socketIo instanceof Server) {
    // If a Socket.IO instance is already provided
    io = options.socketIo;
  } else {
    // Create a new Socket.IO instance with updated options
    io = new Server(httpServer, {
      // Example CORS configuration; adjust as needed
      cors: {
        origin: options.socketIo?.cors?.origin || "*",
        methods: options.socketIo?.cors?.methods || ["GET", "POST"]
      },
      // Additional Socket.IO options can be added here
      ...options.socketIo?.options
    });

    // If an adapter is provided, use it
    if (options.socketIo?.adapter) {
      io.adapter(options.socketIo.adapter);
    }
  }

  server.sockets = io;

  // Persist sessions in a store
  server.sessions = new SessionStore('sessions', server.db, server.sockets, options.sessions);

  // Persist keys in a store
  server.keys = new Keys();

  // Handle HTTP requests
  server.handleRequest = function handleRequest(req, res, nextMiddleware) {
    // Don't handle Socket.IO requests
    if (req.url.startsWith('/socket.io/')) return;

    debug('%s %s', req.method, req.url);

    // Add utilities to req and res
    setupReqRes(server.options, req, res, (err, next) => {
      if (err) return res.end(err.message);

      let authToken;
      let usesBearerAuth = false;

      if (req.headers && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        const scheme = parts[0];
        const credentials = parts[1];

        if (/^Bearer$/i.test(scheme)) {
          authToken = credentials;
          usesBearerAuth = true;
        }
      }

      server.sessions.createSession(authToken || req.cookies.get('sid'), (err, session) => {
        if (err) {
          debug('session error', err, session);
          throw err;
        } else {
          if (!usesBearerAuth) {
            // (Re)set the session ID cookie if not using Authorization Bearer
            req.cookies.set('sid', session.sid);
          }
          req.session = session;

          const root = req.headers['dpd-ssh-key'] || req.cookies.get('DpdSshKey');

          if (server.options.env === 'development') {
            if (root) {
              req.isRoot = true;
            }
            server.route(req, res, nextMiddleware);
          } else if (root) {
            // All root requests must be authenticated
            debug('authenticating', root);
            server.keys.get(root, (err, key) => {
              if (err) throw err;
              if (key) req.isRoot = true;
              debug('is root?', req.isRoot);
              server.route(req, res, nextMiddleware);
            });
          } else {
            // Normal routing
            server.route(req, res, nextMiddleware);
          }
        }
      });
    });
  };

  const serverPath = server.options.server_dir || fs.realpathSync('./');

  // Ensure the resources directory exists
  const resourcesPath = path.join(serverPath, 'resources');
  if (!fs.existsSync(resourcesPath)) {
    fs.mkdirSync(resourcesPath);
  }

  // Define the routing logic
  server.route = function route(req, res, next) {
    config.loadConfig(serverPath, server, (err, resourcesInstances) => {
      if (err) throw err;
      server.resources = resourcesInstances;
      const router = server.router = new Router(resourcesInstances, server);
      router.route(req, res, next);
    });
  };

  // Handle request errors
  server.on('request:error', (err, req, res) => {
    console.error();
    console.error(req.method, req.url, err.stack || err);
    process.exit(1);
  });

  /**
   * Create a new `Store` for persisting data using the database info.
   *
   * @param {String} namespace - The namespace for the store.
   * @return {Store}
   */
  server.createStore = function(namespace) {
    return (this.stores[namespace] = this.db.createStore(namespace));
  };

  return server;
}

module.exports = attach;
