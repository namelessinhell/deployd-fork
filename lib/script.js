const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const debug = require('debug')('script-loader');
const _ = require('lodash'); // Replaced 'underscore' with 'lodash'
const bluebird = require('bluebird');

/**
 * A `Script` executes JavaScript source code in a sandboxed context
 * and exposes it to a set of domain functions.
 *
 * @class Script
 */
class Script {
  /**
   * Creates an instance of Script.
   *
   * @param {String} src - The source code of the script.
   * @param {String} [filePath] - The file path of the script.
   */
  constructor(src, filePath) {
    this.scriptSourceCode = src;
    this.filePath = filePath;
    this.getFunction = _.memoize(this._createFunction.bind(this));
  }

  /**
   * Creates a new Function instance with the given arguments.
   *
   * @private
   * @param {Array<String>} functionArgs - The argument names for the function.
   * @returns {Function} - The created Function instance.
   */
  _createFunction(functionArgs) {
    return new Function(...functionArgs, this.scriptSourceCode);
  }

  /**
   * Executes the script with the provided context.
   *
   * @param {Object} context - The context to run the script with.
   * @returns {*} - The result of the script execution.
   */
  runWithContext(context) {
    const functionArgs = Object.keys(context).filter(key => key !== 'this');
    const func = this.getFunction(functionArgs);

    const args = functionArgs.map(key => context[key]);
    return func.apply(context._this || {}, args);
  }

  /**
   * Executes the script within a sandboxed environment.
   *
   * @param {Object} ctx - The execution context containing request, session, etc.
   * @param {Object} [domain] - An optional domain to extend the sandbox.
   * @param {Function} fn - Callback function with signature (err).
   */
  async run(ctx, domain, fn) {
    if (this.error) {
      return fn(this.error);
    }

    if (typeof domain === 'function') {
      fn = domain;
      domain = undefined;
    }

    const { req, session, query } = ctx;
    let waitingForCallback = false;
    let callbackCount = 0;
    let isDone = false;
    let events;

    const scriptContext = {
      cancel: this._cancel.bind(this),
      cancelIf: this._cancelIf.bind(this),
      cancelUnless: this._cancelUnless.bind(this),
      me: session && session.user,
      isMe: this._isMe.bind(this),
      console,
      require,
      query,
      internal: req && req.internal,
      isRoot: req && req.session && req.session.isRoot,
      emit: this._emit.bind(this),
      session,
      ctx,
      _this: {},
      _error: undefined,
    };

    events = new EventEmitter();

    const doneCallback = (err) => {
      if (isDone) return;
      isDone = true;
      events.removeAllListeners('finishCallback');
      if (fn) fn(err);
    };

    if (domain) {
      this._setupDomainHandlers(domain, scriptContext, events, doneCallback);
    }

    try {
      this.runWithContext(scriptContext);
    } catch (e) {
      const wrappedError = this._wrapError(e);
      scriptContext._error = wrappedError;
    }

    const finalError = scriptContext._error;
    process.nextTick(() => {
      if (!waitingForCallback && callbackCount <= 0) {
        doneCallback(finalError);
      }
    });
  }

  /**
   * Sets up domain event handlers for asynchronous operations.
   *
   * @private
   * @param {Object} domain - The domain object to extend.
   * @param {Object} scriptContext - The script execution context.
   * @param {EventEmitter} events - The event emitter instance.
   * @param {Function} doneCallback - The callback to execute when done.
   */
  _setupDomainHandlers(domain, scriptContext, events, doneCallback) {
    events.on('addCallback', () => {
      scriptContext.waitingForCallback = true;
      scriptContext.callbackCount++;
    });

    events.on('finishCallback', () => {
      scriptContext.callbackCount--;
      if (scriptContext.callbackCount <= 0) {
        doneCallback(scriptContext._error);
      }
    });

    events.on('error', (err) => {
      doneCallback(err);
    });

    domain.$addCallback = () => {
      events.emit('addCallback');
    };

    domain.$finishCallback = () => {
      events.emit('finishCallback');
    };

    domain.dpd = scriptContext.ctx.dpd;

    if (fn) {
      this._wrapAsyncFunctions(domain, scriptContext, events, doneCallback);
    } else {
      Object.assign(scriptContext, domain);
    }

    scriptContext._this = scriptContext['this'] = domain.data;
  }

  /**
   * Cancels the script execution with an optional message and status.
   *
   * @private
   * @param {String|Error} msg - The cancellation message or error.
   * @param {Number} [status] - The HTTP status code.
   */
  _cancel(msg, status) {
    let err;
    if (msg instanceof Error) {
      err = msg;
    } else if (msg && msg.message && (msg.status || msg.statusCode)) {
      err = { message: msg.message, statusCode: msg.status || msg.statusCode };
    } else {
      err = { message: msg, statusCode: status };
    }
    this.done(err);
    throw err;
  }

  /**
   * Cancels the script execution if the condition is true.
   *
   * @private
   * @param {Boolean} condition - The condition to evaluate.
   * @param {String|Error} msg - The cancellation message or error.
   * @param {Number} [status] - The HTTP status code.
   */
  _cancelIf(condition, msg, status) {
    if (condition) {
      this._cancel(msg, status);
    }
  }

  /**
   * Cancels the script execution unless the condition is true.
   *
   * @private
   * @param {Boolean} condition - The condition to evaluate.
   * @param {String|Error} msg - The cancellation message or error.
   * @param {Number} [status] - The HTTP status code.
   */
  _cancelUnless(condition, msg, status) {
    if (!condition) {
      this._cancel(msg, status);
    }
  }

  /**
   * Checks if the provided ID matches the current user ID.
   *
   * @private
   * @param {String} id - The user ID to check.
   * @returns {Boolean} - True if IDs match, else false.
   */
  _isMe(id) {
    return (this.me && this.me.id === id) || false;
  }

  /**
   * Emits events based on the number of arguments provided.
   *
   * @private
   * @param {String} collection - The collection or room name.
   * @param {Object|String} query - The query object or event name.
   * @param {String} [event] - The event name.
   * @param {Object} [data] - The data to emit.
   */
  _emit(collection, query, event, data) {
    if (arguments.length === 4) {
      this.session.emitToUsers(collection, query, event, data);
    } else if (arguments.length === 3) {
      if (this.session.emitToRoom) {
        this.session.emitToRoom(collection, query, event);
      }
    } else if (arguments.length <= 2) {
      event = collection;
      data = query;
      if (this.session.emitToAll) {
        this.session.emitToAll(event, data);
      }
    }
  }

  /**
   * Wraps and handles errors, preserving error prototypes.
   *
   * @private
   * @param {Error} err - The original error.
   * @returns {Error} - The wrapped error.
   */
  _wrapError(err) {
    if (err && err.__proto__ && global[err.__proto__.name]) {
      err.__proto__ = global[err.__proto__.name].prototype;
    }
    return err;
  }

  /**
   * Checks if an object is a Promise.
   *
   * @private
   * @param {Object} obj - The object to check.
   * @returns {Boolean} - True if the object is a Promise, else false.
   */
  _isPromise(obj) {
    return obj !== null && typeof obj === 'object' && (typeof obj.then === 'function' || this._isPromise(obj.promise));
  }

  /**
   * Wraps a Promise to handle callback counts and errors.
   *
   * @private
   * @param {Promise} promiseable - The original promise.
   * @param {Object} sandbox - The sandbox context.
   * @param {EventEmitter} events - The event emitter instance.
   * @param {Function} done - The callback function.
   * @param {Object} sandboxRoot - The root sandbox context.
   * @returns {Object} - An object containing the wrapped promise and handlers.
   */
  _wrapPromise(promiseable, sandbox, events, done, sandboxRoot) {
    let realPromise = promiseable;
    let ret = null;

    if (!realPromise.then && promiseable.promise && this._isPromise(promiseable.promise)) {
      realPromise = bluebird.cast(promiseable.promise);
      ret = { promise: realPromise, resolve: promiseable.resolve, reject: promiseable.reject };
    }

    if (!ret) {
      ret = bluebird.cast(realPromise);
      realPromise = ret;
    }

    const originalThen = realPromise._then.bind(realPromise);

    const addCallback = () => {
      events.emit('addCallback');
    };

    const finishCallback = () => {
      events.emit('finishCallback');
    };

    addCallback();
    realPromise.then(finishCallback, finishCallback);

    realPromise._then = (...args) => {
      const [onFulfilled, onRejected] = args;

      const wrappedOnFulfilled = onFulfilled
        ? (...resArgs) => {
            addCallback();
            try {
              const result = onFulfilled.apply(this, resArgs);
              return this._isPromise(result) ? this._wrapPromise(result, sandbox, events, done, sandboxRoot) : result;
            } catch (err) {
              sandboxRoot._error = err;
              throw err;
            } finally {
              finishCallback();
            }
          }
        : undefined;

      const wrappedOnRejected = onRejected
        ? (error) => {
            if (error === sandboxRoot._error) {
              sandboxRoot._error = null;
            }
            addCallback();
            try {
              const result = onRejected.apply(this, arguments);
              return this._isPromise(result) ? this._wrapPromise(result, sandbox, events, done, sandboxRoot) : result;
            } catch (err) {
              sandboxRoot._error = this._wrapError(err);
              throw err;
            } finally {
              finishCallback();
            }
          }
        : undefined;

      const newArgs = [wrappedOnFulfilled, wrappedOnRejected, ...args.slice(2)];
      const result = originalThen(...newArgs);
      return this._isPromise(result) ? this._wrapPromise(result, sandbox, events, done, sandboxRoot) : result;
    };

    return ret;
  }

  /**
   * Wraps an asynchronous function to handle callbacks and errors.
   *
   * @private
   * @param {Function} asyncFunction - The asynchronous function to wrap.
   * @param {Object} sandbox - The sandbox context.
   * @param {EventEmitter} events - The event emitter instance.
   * @param {Function} done - The callback function.
   * @param {Object} sandboxRoot - The root sandbox context.
   * @returns {Function} - The wrapped asynchronous function.
   */
  _wrapAsyncFunction(asyncFunction, sandbox, events, done, sandboxRoot) {
    return (...args) => {
      if (sandboxRoot._error) return;

      let callback;
      const callbackIndex = args.findIndex(arg => typeof arg === 'function');
      if (callbackIndex !== -1) {
        callback = args[callbackIndex];
        events.emit('addCallback');
        args[callbackIndex] = (...cbArgs) => {
          if (sandboxRoot._error) return;
          try {
            callback.apply(sandbox._this, cbArgs);
            events.emit('finishCallback');
          } catch (err) {
            const wrappedErr = this._wrapError(err);
            sandbox._error = wrappedErr;
            done(wrappedErr);
          }
        };
      }

      try {
        const result = asyncFunction.apply(sandboxRoot._this, args);
        if (result !== undefined) {
          if (this._isPromise(result)) {
            return this._wrapPromise(result, sandbox, events, done, sandboxRoot);
          } else {
            return result;
          }
        }
      } catch (err) {
        const wrappedErr = this._wrapError(err);
        sandbox._error = wrappedErr;
        done(wrappedErr);
      }
    };
  }

  /**
   * Recursively wraps asynchronous functions within the domain.
   *
   * @private
   * @param {Object} asyncFunctions - The object containing asynchronous functions.
   * @param {Object} sandbox - The sandbox context to attach wrapped functions.
   * @param {EventEmitter} events - The event emitter instance.
   * @param {Function} done - The callback function.
   * @param {Object} [sandboxRoot] - The root sandbox context.
   */
  _wrapAsyncFunctions(asyncFunctions, sandbox, events, done, sandboxRoot = sandbox) {
    if (!asyncFunctions) return;

    Object.keys(asyncFunctions).forEach(key => {
      if (typeof asyncFunctions[key] === 'function') {
        sandbox[key] = this._wrapAsyncFunction(asyncFunctions[key], sandbox, events, done, sandboxRoot);
        this._wrapAsyncFunctions(asyncFunctions[key], sandbox[key], events, done, sandboxRoot);
      } else if (asyncFunctions[key] && typeof asyncFunctions[key] === 'object' && !Array.isArray(asyncFunctions[key])) {
        sandbox[key] = sandbox[key] || {};
        this._wrapAsyncFunctions(asyncFunctions[key], sandbox[key], events, done, sandboxRoot);
      } else {
        sandbox[key] = asyncFunctions[key];
      }
    });
  }

  /**
   * Loads a script from the specified file path.
   *
   * @static
   * @param {String} filePath - The path to the script file.
   * @param {Function} fn - Callback function with signature (err, scriptInstance).
   */
  static async load(filePath, fn) {
    try {
      const src = await fs.readFile(filePath, 'utf-8');
      const script = new Script(src, filePath);
      fn(null, script);
    } catch (err) {
      fn(err);
    }
  }
}

/**
 * Wraps an error to ensure proper prototypes.
 *
 * @param {Error} err - The original error.
 * @returns {Error} - The wrapped error.
 */
function wrapError(err) {
  if (err && err.__proto__ && global[err.__proto__.name]) {
    err.__proto__ = global[err.__proto__.name].prototype;
  }
  return err;
}

module.exports = Script;
