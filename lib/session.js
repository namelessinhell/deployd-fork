const Store = require('./db').Store;
const util = require('util');
const Cookies = require('cookies');
const EventEmitter = require('events').EventEmitter;
const crypto = require('crypto');
const debug = require('debug')('session');
const _ = require('lodash');
const async = require('async');
const validator = require('validator'); // Replaced 'scrubber' with 'validator'

// Enable detailed error logging for the session module
require('debug').enable('session:error');
const error = require('debug')('session:error');

/**
 * A simple index for storing sessions in memory.
 */
const sessionIndex = {};
const userSessionIndex = {};

/**
 * A store for persisting sessions between connection/disconnection.
 * Automatically creates session IDs on inserted objects.
 *
 * @class SessionStore
 * @extends Store
 * @param {String} namespace - The namespace for the store.
 * @param {Store} db - The database instance.
 * @param {SocketIOServer} sockets - The Socket.IO server instance.
 * @param {Object} [options={}] - Configuration options.
 */
function SessionStore(namespace, db, sockets, options = {}) {
  const self = this;

  // Mimic base Store constructor initialization for ES6 class Store
  // so inherited methods (find/insert/...) have required state
  this.namespace = namespace;
  this._db = db;

  // Unique ID for this store to identify in a cluster
  // Fallback if prototype inheritance not yet applied
  this.id = (typeof this.createUniqueIdentifier === 'function')
    ? this.createUniqueIdentifier()
    : require('./db').Store.prototype.createUniqueIdentifier.call(this);

  this.sockets = sockets;
  this.options = options;
  // Sessions inactive for longer than this will be cleaned up (default: 30 days)
  this.options.maxAge = this.options.maxAge || 30 * 24 * 60 * 60 * 1000;

  // Performance optimization: Add session limits and cleanup frequency
  this.options.maxSessions = this.options.maxSessions || 10000; // Maximum sessions in memory
  this.options.cleanupInterval = this.options.cleanupInterval || 30000; // Cleanup every 30 seconds
  this.options.sessionTimeout = this.options.sessionTimeout || 5 * 60 * 1000; // 5 minutes inactive timeout

  // Track session count for memory management
  this.sessionCount = 0;

  if (this.options.pubClient && this.options.subClient) {
    debug('Using pub/sub mode');
    this.pubClient = this.options.pubClient;
    this.subClient = this.options.subClient;
  }

  // Socket queue for handling room synchronization
  this.socketQueue = new EventEmitter();
  this.socketIndex = {};

  if (sockets) {
    if (this.subClient) {
      // Subscribe to messages regarding sessions joining/leaving rooms
      // Need to resync
      this.subClient.subscribe('dpd#session#refreshrooms');
      this.subClient.subscribe('dpd#session#remove');
      this.subClient.on('message', (channel, message) => {
        let data;
        try {
          data = JSON.parse(message);
        } catch (parseError) {
          debug(`Failed to parse message: ${parseError.message}`);
          return;
        }

        switch (channel) {
          case 'dpd#session#refreshrooms':
            // Another node changed rooms for a session
            if (data.id !== self.id && data.sid && self.socketIndex[data.sid]) {
              // If we know about this session, refresh the rooms
              self.refreshSessionRooms(data.sid);
            }
            break;
          case 'dpd#session#remove':
            // Another node removed a session
            if (data.id !== self.id && data.sid && sessionIndex[data.sid]) {
              // If we know about this session, remove it from memory
              sessionIndex[data.sid]._leaveAllRooms();
              self.removeSessionFromMemory(data.sid);
            }
            break;
          default:
            debug(`Unhandled channel: ${channel}`);
        }
      });
    }

    // Handle new Socket.IO connections
    sockets.on('connection', (client) => {
      // NOTE: Do not use `set` here; the `Cookies` API is meant to get req and res,
      // but we're using it here for cookie parsing only
      const cookies = new Cookies(client.handshake);
      const sid = cookies.get('sid');

      /**
       * Retrieves the session based on the session ID.
       *
       * @param {String} sid - The session ID.
       * @param {Function} fn - Callback function.
       */
      const getSession = (sid, fn) => {
        // Check if we already know about the session
        const session = sessionIndex[sid];
        if (session) return fn(null, session);

        // Retrieve the session from the store otherwise
        self.createSession(sid, (err, session) => {
          if (err) return fn(err);
          if (session && session.data.id === sid) return fn(null, session);
          return fn();
        });
      };

      /**
       * Indexes the socket against its session ID.
       *
       * @param {String} sid - The session ID.
       * @param {Socket} client - The connected socket.
       * @param {Session} session - The session instance.
       */
      const indexSocket = (sid, client, session) => {
        // Index sockets against their session ID
        self.socketIndex[sid] = self.socketIndex[sid] || {};
        self.socketIndex[sid][client.id] = client;
        self.socketQueue.emit('socket', client, session);

        // Ensure the list of rooms to join is fresh
        self.refreshSessionRooms(sid, () => {
          client.emit('server:acksession');
        });
      };

      if (sid) {
        getSession(sid, (err, session) => {
          if (session) {
            indexSocket(sid, client, session);
          }
        });
      }

      /**
       * Alternative method for binding session to socket connection
       * when the `sid` cookie is not yet available.
       * Expects the client to emit an event with the `sid`.
       *
       * @param {Object} data - Data containing the session ID.
       */
      const setSession = (data) => {
        if (!data || !data.sid || typeof data.sid !== 'string') return;
        const sid = data.sid;

        getSession(sid, (err, session) => {
          if (session) {
            // Unassign socket from previous sessions
            _.each(self.socketIndex, (val) => {
              delete val[client.id];
            });

            indexSocket(sid, client, session);
          }
        });
      };

      // Listen for session binding events from the client
      client.on('server:setSession', setSession);
      client.on('server:setsession', setSession); // Allow lowercase

      // Handle socket disconnection
      client.on('disconnect', () => {
        // Unassign socket from previous sessions
        _.each(self.socketIndex, (val) => {
          delete val[client.id];
        });
      });
    });

    /**
     * Drain the queue for a specific socket method once the socket is ready.
     *
     * @param {String} method - The socket method to drain (e.g., 'on', 'emit').
     * @param {Socket} rawSocket - The socket instance.
     * @param {Session} session - The session instance.
     */
    const drainQueue = (method, rawSocket, session) => {
      const key = `_${method}`;
      if (session.socket._bindQueue && session.socket._bindQueue[key] && session.socket._bindQueue[key].length) {
        session.socket._bindQueue[key].forEach((args) => {
          rawSocket[method].apply(rawSocket, args);
        });
      }
    };

    // Resolve queue once a socket is ready
    self.socketQueue.on('socket', (socket, session) => {
      drainQueue('on', socket, session);
      drainQueue('emit', socket, session);
      drainQueue('join', socket, session);
      drainQueue('leave', socket, session);
    });
  }

  // Inherit from Store
  util.inherits(SessionStore, Store);
  module.exports.SessionStore = SessionStore;

  /**
   * Create a new `Session` based on an optional `sid` (session id).
   *
   * @param {String} sid - The session ID.
   * @param {Function} fn - Callback function.
   */
  SessionStore.prototype.createSession = function (sid, fn) {
    const socketIndex = this.socketIndex;
    const store = this;

    if (typeof sid === 'function') {
      fn = sid;
      sid = undefined;
    }

    if (sid) {
      // Fast-path: serve from in-memory cache when available and not expired
      const cached = sessionIndex[sid];
      if (cached && cached.data && cached.data.lastActive >= Date.now() - store.options.maxAge) {
        // Optionally refresh lastActive at most every 10 seconds
        if (!cached.data.anonymous && (!cached.data.lastActive || cached.data.lastActive < Date.now() - 10 * 1000)) {
          cached.data.lastActive = Date.now();
          cached.save(() => fn(null, cached));
          return;
        }
        return fn(null, cached);
      }

      this.find({ id: sid }, (err, s) => {
        if (err) return fn(err);
        if (!s || s.lastActive < Date.now() - store.options.maxAge) {
          s = { anonymous: true };
          sid = null;
        }
        const sess = sessionIndex[sid] || new Session(s, store, socketIndex, store.sockets);
        if (sid && !sessionIndex[sid]) {
          sessionIndex[sid] = sess;
          store.sessionCount++;
        }

        // Index sessions by user
        if (s && s.uid) {
          userSessionIndex[s.uid] = userSessionIndex[s.uid] || {};
          userSessionIndex[s.uid][sess.data.id] = sess;
        }

        if (!sess.data.anonymous && (!sess.data.lastActive || sess.data.lastActive < Date.now() - 10 * 1000)) {
          // Update last active date at max once every 10 seconds
          sess.data.lastActive = Date.now();
          sess.save((err) => {
            fn(err, sess);
          });
        } else {
          fn(null, sess);
        }
      });
    } else {
      fn(null, new Session({ anonymous: true }, this, socketIndex, this.sockets));
    }

    // Clean up inactive sessions once per minute
    if (this.cleanupInactiveSessions.lastRun < Date.now() - 60 * 1000) {
      process.nextTick(() => {
        this.cleanupInactiveSessions();
      });
    }
  };

  /**
   * Refresh the rooms for a given session.
   *
   * @param {String} sid - The session ID.
   * @param {Function} [fn] - Callback function.
   */
  SessionStore.prototype.refreshSessionRooms = function (sid, fn = () => {}) {
    if (!this.socketIndex[sid]) return fn(null, false);

    // Reload session
    this.createSession(sid, (err, session) => {
      if (err) return fn(err);
      if (session.data && session.data.id === sid && session.data._rooms) {
        // Make sure each room is joined
        session._leaveAllRooms(session.data._rooms, () => {
          _.each(this.socketIndex[sid], (socket) => {
            session.data._rooms.forEach((room) => {
              socket.join(room);
            });
          });

          fn(null, true);
        });
      } else {
        fn(null, false);
      }
    });
  };

  /**
   * Retrieve a session by user ID and session ID.
   *
   * @param {String} uid - The user ID.
   * @param {String} sid - The session ID.
   * @return {Session|null} - The session instance or null if not found.
   */
  SessionStore.prototype.getSession = function (uid, sid) {
    return userSessionIndex[uid]?.[sid] || null;
  };

  /**
   * Remove a session from memory.
   *
   * @param {String} sid - The session ID.
   */
  SessionStore.prototype.removeSessionFromMemory = function (sid) {
    if (sessionIndex[sid]) {
      delete sessionIndex[sid];
      this.sessionCount--;
    }

    _.each(userSessionIndex, (sessions) => {
      delete sessions[sid];
    });
    delete this.socketIndex[sid];
  };

  /**
   * Clean up inactive sessions from the database.
   */
  SessionStore.prototype.cleanupInactiveSessions = function () {
    const inactiveSessions = [];
    const now = Date.now();
    const timeoutThreshold = now - this.options.sessionTimeout;

    // Check if we need to enforce session limits
    if (this.sessionCount > this.options.maxSessions) {
      debug(`Session count (${this.sessionCount}) exceeds limit (${this.options.maxSessions}), forcing cleanup`);
    }

    _.each(sessionIndex, (session, sid) => {
      // More aggressive cleanup for memory management
      if (session.data.lastActive < timeoutThreshold && _.isEmpty(this.socketIndex[sid])) {
        inactiveSessions.push(sid);
      }
    });

    // If we're over the limit, remove oldest sessions first
    if (this.sessionCount > this.options.maxSessions) {
      const sessionsToRemove = this.sessionCount - this.options.maxSessions;
      const oldestSessions = Object.keys(sessionIndex)
        .map(sid => ({ sid, lastActive: sessionIndex[sid].data.lastActive }))
        .sort((a, b) => a.lastActive - b.lastActive)
        .slice(0, sessionsToRemove)
        .map(s => s.sid);

      inactiveSessions.push(...oldestSessions);
    }

    _.each(inactiveSessions, (sid) => {
      this.removeSessionFromMemory(sid);
    });

    // Update session count
    this.sessionCount = Object.keys(sessionIndex).length;

    this.remove(
      {
        $or: [
          { lastActive: { $lt: now - this.options.maxAge } },
          { lastActive: { $exists: false } },
        ],
      },
      (err) => {
        if (err) {
          error(`Error removing old sessions: ${err}`);
        }
      }
    );

    this.cleanupInactiveSessions.lastRun = now;
    debug(`Cleaned up ${inactiveSessions.length} sessions. Current count: ${this.sessionCount}`);
  };

  /**
   * Publish a message to a specific channel.
   *
   * @param {String} channel - The channel to publish to.
   * @param {Object} data - The data to publish.
   */
  SessionStore.prototype.publish = function (channel, data) {
    if (this.pubClient) {
      this.pubClient.publish(channel, JSON.stringify(data));
    }
  };
}

/**
 * In-memory representation of a client or user connection that can be saved to disk.
 * Data will be passed around via a `Context` to resources.
 *
 * @class Session
 * @param {Object} data - The session data.
 * @param {SessionStore} store - The session store instance.
 * @param {Object} sockets - The socket index.
 * @param {SocketIOServer} rawSockets - The raw Socket.IO server instance.
 */
function Session(data, store, sockets, rawSockets) {
  const self = this;

  this.data = _.clone(data) || {};
  if (!this.data.createdOn) this.data.createdOn = Date.now();
  if (!this.data.lastActive) this.data.lastActive = Date.now();
  if (data && data.id) this.sid = data.id;
  this.store = store;
  this.socketIndex = sockets;
  this.rawSockets = rawSockets;

  /**
   * Binds a method to the socket, queuing it if the socket isn't ready yet.
   *
   * @param {String} method - The socket method (e.g., 'on', 'emit').
   * @param {Array} args - The arguments to pass to the socket method.
   */
  const bindFauxSocket = (method, queue) => {
    const invokeOnLiveSockets = (...args) => {
      let handled = false;

      if (self.socket && !self.socket._bindQueue && typeof self.socket[method] === 'function') {
        self.socket[method](...args);
        handled = true;
      }

      if (self.sid && self.store && self.store.socketIndex) {
        const socketsForSession = self.store.socketIndex[self.sid];
        if (socketsForSession) {
          Object.keys(socketsForSession).forEach((socketId) => {
            const liveSocket = socketsForSession[socketId];
            if (liveSocket && typeof liveSocket[method] === 'function') {
              liveSocket[method](...args);
              handled = true;
            }
          });
        }
      }

      return handled;
    };

    return (...args) => {
      if (!invokeOnLiveSockets(...args)) {
        queue[method] = queue[method] || [];
        queue[method].push(args);
      }
    };
  };

  // Create a faux socket to queue any events until a real socket is available
  this.socket = {
    _bindQueue: {},
  };

  this.socket.on = bindFauxSocket('on', this.socket._bindQueue);
  this.socket.emit = bindFauxSocket('emit', this.socket._bindQueue);
  this.socket.join = bindFauxSocket('join', this.socket._bindQueue);
  this.socket.leave = bindFauxSocket('leave', this.socket._bindQueue);

  // If the session has a user ID, set it
  if (data && data.uid) this.setUid(data.uid);

  /**
   * Emit an event to specific users.
   *
   * @param {Collection} collection - The collection to query users.
   * @param {Object} query - The query to find users.
   * @param {String} event - The event name.
   * @param {Object} data - The data to emit.
   */
  this.emitToUsers = function (collection, query, event, data) {
    collection.get(query, (users) => {
      if (users && users.id) {
        users = [users]; // Convert single item to array
      }

      users.forEach((u) => {
        self.rawSockets.to(self.getUserChannel(u.id)).emit(event, data);
      });
    });
  };

  /**
   * Emit an event to all connected clients.
   *
   * @param {...any} args - The arguments to pass to the emit method.
   */
  this.emitToAll = function (...args) {
    self.rawSockets.emit(...args);
  };

  /**
   * Emit an event to a specific room.
   *
   * @param {String} room - The room name.
   * @param {String} event - The event name.
   * @param {Object} data - The data to emit.
   */
  this.emitToRoom = function (room, event, data) {
    self.rawSockets.to(room).emit(event, data);
  };

  /**
   * Save the current rooms and publish a refresh event.
   */
  const saveRooms = () => {
    self.save((err, data) => {
      if (!err) {
        // Publish to other nodes that we need to refresh rooms for this session
        self.store.publish('dpd#session#refreshrooms', { id: self.store.id, sid: self.sid });
      }
    });
  };

  /**
   * Join one or more rooms and store them in the session.
   *
   * @param {String|Array} rooms - The room or rooms to join.
   */
  this.joinRoom = this.joinRooms = (rooms) => {
    let currentRooms = (self.data._rooms = self.data._rooms || []);
    if (typeof rooms === 'string') rooms = [rooms];
    _.each(rooms, (room) => {
      if (!currentRooms.includes(room)) currentRooms.push(room);
      self.socket.join(room);
    });

    saveRooms();
  };

  /**
   * Leave one or more rooms and update the session.
   *
   * @param {String|Array} rooms - The room or rooms to leave.
   */
  this.leaveRoom = this.leaveRooms = (rooms) => {
    let currentRooms = (self.data._rooms = self.data._rooms || []);
    if (typeof rooms === 'string') rooms = [rooms];
    _.each(rooms, (room) => {
      const index = currentRooms.indexOf(room);
      if (index !== -1) currentRooms.splice(index, 1);
      self.socket.leave(room);
    });

    saveRooms();
  };

  /**
   * Leave all rooms except the specified ones.
   *
   * @param {Array} [except=[]] - Rooms to remain in.
   * @param {Function} [fn] - Callback function.
   */
  this._leaveAllRooms = (except = [], fn = () => {}) => {
    const userChannel = self.getUserChannel();

    async.forEachOf(
      self.store.socketIndex[self.sid] || {},
      (socket, id, outerCallback) => {
        async.each(
          _.difference(_.without(socket.rooms, socket.id, userChannel), except),
          (room, innerCallback) => {
            socket.leave(room, innerCallback);
          },
          outerCallback
        );
      },
      fn
    );
  };

  /**
   * Leave all rooms and update the session.
   */
  this.leaveAllRooms = () => {
    self._leaveAllRooms();
    self.data._rooms = [];
    saveRooms();
  };
}

/**
 * Inherit from EventEmitter to allow session instances to emit events.
 */
util.inherits(Session, EventEmitter);

/**
 * Set properties on the in-memory representation of a session.
 *
 * @param {Object} changes - The properties to set.
 * @return {Session} - Returns the session instance for chaining.
 */
Session.prototype.set = function (changes) {
  Object.keys(changes).forEach((key) => {
    this.data[key] = changes[key];
  });

  if (changes && changes.uid) {
    this.setUid(changes.uid);
  }

  return this;
};

/**
 * Get the user-specific channel name.
 *
 * @param {String} [uid] - The user ID.
 * @return {String|undefined} - The channel name or undefined.
 */
Session.prototype.getUserChannel = function (uid) {
  const userId = uid || this.data.uid;
  if (userId) {
    return `dpd_uid:${userId}`;
  }
};

/**
 * Set the user ID for this session.
 *
 * @param {String} uid - The user ID.
 * @return {Session} - Returns the session instance for chaining.
 */
Session.prototype.setUid = function (uid) {
  if (this.data.uid !== uid) {
    // Remove socket from previous user channel
    this.socket.leave(this.getUserChannel(this.data.uid));
  }

  if (uid) {
    this.data.uid = uid;
    this.socket.join(this.getUserChannel(uid));
  }

  return this;
};

/**
 * Save the in-memory representation of a session to its store.
 *
 * @param {Function} [fn] - Callback function.
 * @return {Session} - Returns the session instance for chaining.
 */
Session.prototype.save = function (fn = () => {}) {
  const self = this;
  const data = _.clone(this.data);
  let anonymous = false;
  let sid = null;

  if (data.anonymous) {
    delete data.anonymous;
    sid = (data.id = this.store.createUniqueIdentifier());
    anonymous = true;
  } else {
    sid = data.id;
  }

  if (typeof data.id !== 'string') {
    return fn('Invalid session ID');
  }

  // If anonymous, create a new session
  if (anonymous) {
    this.store.insert(data, (err, res) => {
      if (!err) {
        this.data = res;
        sessionIndex[sid] = this;

        if (res.uid) {
          userSessionIndex[res.uid] = userSessionIndex[res.uid] || {};
          userSessionIndex[res.uid][this.data.id] = this;
        }
        this.sid = res.id;
      }
      fn(err, res);
    });
  }
  // If already authenticated and we have sid, update session
  else if (sid) {
    delete data.id;
    this.store.update({ id: sid }, data, (err) => {
      if (!err) {
        data.id = sid;
        this.data = data;
        sessionIndex[sid] = this;

        if (data.uid) {
          userSessionIndex[data.uid] = userSessionIndex[data.uid] || {};
          userSessionIndex[data.uid][this.data.id] = this;
        }
        this.sid = data.id;
      }
      fn(err, data);
    });
  }

  return this;
};

/**
 * Reset the session using the data in its store.
 *
 * @param {Function} [fn] - Callback function.
 * @return {Session} - Returns the session instance for chaining.
 */
Session.prototype.fetch = function (fn = () => {}) {
  this.store.first({ id: this.data.id }, (err, data) => {
    this.set(data);
    fn(err, data);
  });
  return this;
};

/**
 * Check if the session is anonymous (non-authenticated).
 *
 * @return {Boolean} - True if anonymous, else false.
 */
Session.prototype.isAnonymous = function () {
  return this.data.anonymous;
};

/**
 * Remove the session.
 *
 * @param {Object|Function} [data] - Data to remove or callback function.
 * @param {Function} [fn] - Callback function.
 * @return {Session} - Returns the session instance for chaining.
 */
Session.prototype.remove = function (data, fn) {
  if (typeof data === 'function') {
    fn = data;
    data = this.data;
  }
  if (!data.id || typeof data.id !== 'string') {
    return fn(); // Nothing to remove
  }
  const self = this;
  debug(`Removing session: ${data.id}`);

  delete sessionIndex[data.id];
  if (userSessionIndex[data.uid]?.[data.id]) {
    delete userSessionIndex[data.uid][data.id];
  }
  this.leaveAllRooms();
  if (this.store.socketIndex[data.id]) {
    delete this.store.socketIndex[data.id];
  }

  this.store.remove({ id: data.id }, (err) => {
    if (err) {
      error(`Error removing session: ${err}`);
    }
    fn(err, data);
  });

  if (this.sid) {
    this.store.publish('dpd#session#remove', { id: this.store.id, sid: data.id });
  }

  return this;
};

// Export both the constructor itself and a named property for maximum compatibility
module.exports = SessionStore;
module.exports.SessionStore = SessionStore;
