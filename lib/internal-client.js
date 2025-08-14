const debug = require('debug')('internal-client');
const path = require('path');
const { URL } = require('url');

/**
 * Normalize an array of path segments.
 *
 * @param {Array<string>} parts - The path segments to normalize.
 * @param {boolean} allowAboveRoot - Whether to allow the path to go above the root.
 * @returns {Array<string>} - The normalized path segments.
 */
function normalizeArray(parts, allowAboveRoot = false) {
  let up = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // Restore leading '..'s if allowed
  if (allowAboveRoot) {
    for (; up > 0; up--) {
      parts.unshift('..');
    }
  }

  return parts;
}

/**
 * Normalize a URL path.
 *
 * @param {string} inputPath - The URL path to normalize.
 * @returns {string} - The normalized path.
 */
function normalizePath(inputPath) {
  const isAbsolute = inputPath.startsWith('/');
  const trailingSlash = inputPath.endsWith('/');

  const parts = inputPath.split('/').filter(Boolean);
  const normalizedParts = normalizeArray(parts, !isAbsolute);
  let normalizedPath = normalizedParts.join('/');

  if (!normalizedPath && !isAbsolute) {
    normalizedPath = '.';
  }
  if (normalizedPath && trailingSlash) {
    normalizedPath += '/';
  }

  return `${isAbsolute ? '/' : ''}${normalizedPath}`;
}

/**
 * Join multiple path segments into a single path.
 *
 * @param  {...string} segments - The path segments to join.
 * @returns {string} - The joined and normalized path.
 */
function joinPath(...segments) {
  const filteredSegments = segments.filter(seg => typeof seg === 'string' && seg.trim() !== '');
  const joinedPath = filteredSegments.join('/');
  return normalizePath(joinedPath);
}

/**
 * InternalClient class responsible for building and handling internal API requests.
 */
class InternalClient {
  /**
   * Creates an instance of InternalClient.
   *
   * @param {Object} server - The server instance.
   * @param {Object} session - The session object.
   * @param {Array<string>} stack - The current stack of routes to prevent recursion.
   * @param {Object} ctx - The context object.
   */
  constructor(server, session = {}, stack = [], ctx = {}) {
    this.server = server;
    this.session = session;
    this.stack = stack;
    this.ctx = ctx;
  }

  /**
   * Builds the internal client with methods for making API requests.
   *
   * @returns {Object} - The built internal client with API methods.
   */
  build() {
    const baseMethods = {
      /**
       * Makes an internal API request.
       *
       * @param {string} method - The HTTP method (GET, POST, PUT, DELETE).
       * @param {Object} options - The request options.
       * @param {Function} [fn] - Optional callback function for backwards compatibility.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      request: async (method, options, fn) => {
        try {
          const { path: requestPath, query = {}, body = {} } = options;

          const urlPath = joinPath('/', requestPath);
          const urlKey = `${method.toUpperCase()} ${urlPath}`;

          // Prevent recursion beyond the limit
          const recursions = this.stack.filter(s => s === urlKey).length;
          const recursionLimit = (this.stack.recursionLimit) || 2;

          if (recursions >= recursionLimit) {
            debug(`Recursive call detected for "${urlKey}" - aborting.`);
            if (fn) fn(null, `Recursive call to ${urlKey} detected`);
            return Promise.resolve(`Recursive call to ${urlKey} detected`);
          }

          // Add to stack
          this.stack.push(urlKey);
          debug(`Adding "${urlKey}" to stack.`);

          // Create mock req and res objects
          const req = {
            url: urlPath,
            method,
            query,
            body,
            session: this.session,
            isRoot: this.session.isRoot || false,
            internal: true,
            headers: (this.ctx.req && this.ctx.req.headers) || {},
            connection: (this.ctx.req && this.ctx.req.connection) || {},
            on: () => {}, // Stubbed methods
            resume: () => {}
          };

          const res = {
            statusCode: 200,
            headers: {},
            getHeader: () => {},
            setHeader: () => {},
            end: (data) => {
              try {
                const parsedData = JSON.parse(data);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  callback(null, parsedData);
                } else {
                  callback(parsedData, null);
                }
              } catch (ex) {
                callback(data, null);
              }
            },
            internal: true,
            on: () => {}
          };

          const responsePromise = new Promise((resolve, reject) => {
            const callback = (data, error) => {
              if (error) {
                reject(error);
              } else {
                resolve(data);
              }
            };

            // Route the request using the server's router
            this.server.router.route(req, res, () => {
              // If no resource handled the request, resolve with 404 message
              debug(`No resource handled the request for "${urlKey}" - responding with 404.`);
              res.statusCode = 404;
              res.end(JSON.stringify({ message: 'Resource not found' }));
            });
          });

          // Handle optional callback for backwards compatibility
          if (typeof fn === 'function') {
            responsePromise
              .then(data => fn(data))
              .catch(error => fn(null, error));
          }

          return responsePromise;
        } catch (error) {
          debug(`Error in request: ${error.message}`);
          if (fn) fn(null, error);
          throw error;
        }
      },

      /**
       * Makes a GET request.
       *
       * @param {Object} options - The request options.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      get: (options, fn) => baseMethods.request.call(this, 'GET', options, fn),

      /**
       * Makes a POST request.
       *
       * @param {Object} options - The request options.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      post: (options, fn) => baseMethods.request.call(this, 'POST', options, fn),

      /**
       * Makes a PUT request.
       *
       * @param {Object} options - The request options.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      put: (options, fn) => baseMethods.request.call(this, 'PUT', options, fn),

      /**
       * Makes a DELETE request.
       *
       * @param {Object} options - The request options.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      del: (options, fn) => baseMethods.request.call(this, 'DELETE', options, fn)
    };

    // Initialize dpd object
    const dpd = {};

    // Iterate over server resources to generate client methods
    if (this.server.resources && Array.isArray(this.server.resources)) {
      this.server.resources.forEach(resource => {
        if (resource.clientGeneration) {
          const jsName = resource.path.replace(/[^A-Za-z0-9]/g, '');
          dpd[jsName] = this.createResourceClient(resource, baseMethods);
        }
      });
    }

    return dpd;
  }

  /**
   * Creates a client object for a specific resource with methods to interact with it.
   *
   * @param {Object} resource - The resource object.
   * @param {Object} baseMethods - The base methods for making requests.
   * @returns {Object} - The client object with API methods.
   */
  createResourceClient(resource, baseMethods) {
    const client = {
      /**
       * Makes a GET request to the resource.
       *
       * @param {string} [path=''] - The specific path to append.
       * @param {Object} [query={}] - The query parameters.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      get: (path = '', query = {}, fn) => {
        const settings = this.parseGetSignature(arguments);
        settings.path = joinPath(resource.path, settings.path);
        return baseMethods.get.call(this, settings, settings.fn);
      },

      /**
       * Makes a POST request to the resource.
       *
       * @param {string} [path=''] - The specific path to append.
       * @param {Object} [query={}] - The query parameters.
       * @param {Object} [body={}] - The request body.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      post: (path = '', query = {}, body = {}, fn) => {
        const settings = this.parsePostSignature(arguments);
        settings.path = joinPath(resource.path, settings.path);
        return baseMethods.post.call(this, settings, settings.fn);
      },

      /**
       * Makes a PUT request to the resource.
       *
       * @param {string} [path=''] - The specific path to append.
       * @param {Object} [query={}] - The query parameters.
       * @param {Object} [body={}] - The request body.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      put: (path = '', query = {}, body = {}, fn) => {
        const settings = this.parsePostSignature(arguments);
        settings.path = joinPath(resource.path, settings.path);
        return baseMethods.put.call(this, settings, settings.fn);
      },

      /**
       * Makes a DELETE request to the resource.
       *
       * @param {string} [path=''] - The specific path to append.
       * @param {Object} [query={}] - The query parameters.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      del: (path = '', query = {}, fn) => {
        const settings = this.parseGetSignature(arguments);
        settings.path = joinPath(resource.path, settings.path);
        return baseMethods.del.call(this, settings, settings.fn);
      },

      /**
       * Executes a specific function on the resource.
       *
       * @param {string} func - The function to execute.
       * @param {string} [path=''] - The specific path to append.
       * @param {Object} [body={}] - The request body.
       * @param {Function} [fn] - Optional callback function.
       * @returns {Promise<any>} - A promise that resolves with the response data or rejects with an error.
       */
      exec: (func, path = '', body = {}, fn) => {
        const settings = {};
        settings.func = func;

        if (typeof path === 'string') {
          settings.path = path;
        }

        if (typeof body === 'object') {
          settings.body = body;
        }

        fn = typeof fn === 'function' ? fn : undefined;

        settings.path = joinPath(resource.path, settings.func, settings.path);
        return baseMethods.post.call(this, settings, fn);
      }
    };

    // Add custom get methods for clientGenerationGet
    if (Array.isArray(resource.clientGenerationGet)) {
      resource.clientGenerationGet.forEach(func => {
        client[func] = (path = '', query = {}, fn) => {
          client.get(func, path, query, fn);
        };
      });
    }

    // Add custom exec methods for clientGenerationExec
    if (Array.isArray(resource.clientGenerationExec)) {
      resource.clientGenerationExec.forEach(func => {
        client[func] = (path = '', query = {}, fn) => {
          client.exec(func, path, query, fn);
        };
      });
    }

    /**
     * Retrieves the original resource object.
     *
     * @returns {Object} - The resource object.
     */
    client.getResource = () => resource;

    return client;
  }

  /**
   * Parses the signature for GET requests.
   *
   * @param {IArguments} args - The arguments object.
   * @returns {Object} - The parsed settings.
   */
  parseGetSignature(args) {
    const settings = {};
    let i = 0;

    // Path or function name
    if (this.isString(args[i])) {
      settings.path = this.toString(args[i]);
      i++;
    }

    // Additional path segment
    if (this.isString(args[i])) {
      settings.path = joinPath(settings.path, this.toString(args[i]));
      i++;
    }

    // Query parameters
    if (typeof args[i] === 'object') {
      settings.query = args[i];
      i++;
    }

    // Callback function
    if (typeof args[i] === 'function') {
      settings.fn = args[i];
    }

    return settings;
  }

  /**
   * Parses the signature for POST and PUT requests.
   *
   * @param {IArguments} args - The arguments object.
   * @returns {Object} - The parsed settings.
   */
  parsePostSignature(args) {
    const settings = {};
    let i = 0;

    // Path
    if (this.isString(args[i])) {
      settings.path = this.toString(args[i]);
      i++;
    }

    // Body
    if (typeof args[i] === 'object') {
      settings.body = args[i];
      i++;
    }

    // Query parameters (if exists, the last object is query and the new one is body)
    if (typeof args[i] === 'object') {
      settings.query = settings.body;
      settings.body = args[i];
      i++;
    }

    // Callback function
    if (typeof args[i] === 'function') {
      settings.fn = args[i];
    }

    return settings;
  }

  /**
   * Checks if the argument is a string or number.
   *
   * @param {*} arg - The argument to check.
   * @returns {boolean} - True if the argument is a string or number, else false.
   */
  isString(arg) {
    return typeof arg === 'string' || typeof arg === 'number';
  }

  /**
   * Converts an argument to a string.
   *
   * @param {*} arg - The argument to convert.
   * @returns {string|null} - The string representation or null.
   */
  toString(arg) {
    return arg ? String(arg) : null;
  }
}

module.exports = InternalClient;
