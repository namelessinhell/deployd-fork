const path = require('path');
const EventEmitter = require('events').EventEmitter;
const util = require('util');
const fs = require('fs').promises;
const debug = require('debug')('resource');
const _ = require('lodash'); // Replaced 'underscore' with 'lodash'
const Script = require('./script');

/**
 * A `Resource` handles incoming requests at a matched URL. The base class is designed
 * to be extended by overriding methods that will be called by a `Router`.
 *
 * A `Resource` is also an `EventEmitter`. The following events are available:
 *
 *   - `changed`      after a resource config has changed
 *   - `deleted`      after a resource config has been deleted
 *
 * Options:
 *
 *   - `path`         the base path a resource should handle
 *   - `db`           the database a resource will use for persistence
 *
 * Example:
 *
 *   The following resource would respond with a file at the URL `/my-file.html`.
 *
 *     class MyFileResource extends Resource {
 *       constructor(name, options) {
 *         super(name, options);
 *
 *         this.on('changed', (config) => {
 *           console.log('MyFileResource changed', config);
 *         });
 *       }
 *
 *       async handle(ctx, next) {
 *         if (ctx.url === '/my-file.html') {
 *           try {
 *             const data = await fs.readFile('my-file.html', 'utf-8');
 *             ctx.res.end(data);
 *           } catch (err) {
 *             ctx.done(err);
 *           }
 *         } else {
 *           next();
 *         }
 *       }
 *     }
 *
 * @class Resource
 * @extends EventEmitter
 * @param {String} name - The name of the resource.
 * @param {Object} [options={}] - Configuration options.
 * @api public
 */
class ResourceClass extends EventEmitter {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this.path = `/${name}`;
    this.options = options;
    this.config = options.config || {};
    this.events = {};
    this.external = {};

    if (this.constructor.external) {
      Object.keys(this.constructor.external).forEach((key) => {
        if (typeof this.constructor.external[key] === 'function') {
          this.external[key] = (...args) => {
            this.constructor.external[key].apply(this, args);
          };
        }
      });
    }

    this.clientGeneration = false;
    this.clientGenerationGet = [];
    this.clientGenerationExec = [];

    this.__resource__ = true;
  }

  /**
   * Parse the `url` into a basepath, query, and parts.
   *
   * @param {String} url - The URL to parse.
   * @returns {Object} - The parsed URL components.
   * @api private
   */
  parse(url) {
    const parsed = new URL(url, `http://${this.serverHost || 'localhost'}`);
    const pathname = parsed.pathname;
    const parts = pathname.split('/').filter(part => part !== '');

    parsed.parts = parts;
    parsed.basepath = parts[0] || '';

    // The last part is always the identifier if there are multiple parts
    if (parts.length > 1) {
      parsed.id = parts[parts.length - 1];
    }

    // Parse the query if it exists and is a valid JSON
    if (parsed.searchParams.has('q')) {
      const qParam = parsed.searchParams.get('q');
      if (qParam.startsWith('{') && qParam.endsWith('}')) {
        try {
          parsed.query = { q: JSON.parse(qParam) };
        } catch (ex) {
          debug('Failed to parse query parameter "q" as JSON:', ex.message);
          parsed.query = {};
        }
      }
    }

    return parsed;
  }

  /**
   * Asynchronously loads scripts corresponding to resource events.
   *
   * @param {Function} fn - Callback function to execute after loading.
   * @returns {Promise<void>}
   * @api public
   */
  async load(fn) {
    const eventNames = this.constructor.events || [];
    const configPath = this.options.configPath || path.join(__dirname, 'config');
    this.events = {};

    const hasCallback = typeof fn === 'function';
    if (eventNames.length === 0) {
      if (hasCallback) return fn();
      return; // nothing to load
    }

    try {
      await Promise.all(eventNames.map(async (event) => {
        const fileName = `${event.toLowerCase()}.js`;
        const filePath = path.join(configPath, fileName);

        try {
          const script = await Script.load(filePath);
          if (script) {
            this.events[event] = script;
            debug(`Loaded script for event "${event}" from "${filePath}"`);
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            debug(`Script file for event "${event}" not found at "${filePath}". Skipping.`);
          } else {
            console.error(`Error loading script for event "${event}" from "${filePath}":`, err.message);
            console.error(err.stack || err);
            if (process.send) process.send({ moduleError: err || true });
            throw err;
          }
        }
      }));
      if (hasCallback) fn();
    } catch (err) {
      console.error('Unexpected error during script loading:', err.message);
      console.error(err.stack || err);
      if (process.send) process.send({ moduleError: err || true });
      throw err;
    }
  }

  /**
   * Handle an incoming request. This gets called by the router.
   * Call `next()` if the resource cannot handle the request.
   * Otherwise call `ctx.done(err, res)` when the resource
   * is ready to respond.
   *
   * Example:
   *
   *  Override the handle method to return a string:
   *
   *     class MyResource extends Resource {
   *       constructor(name, options) {
   *         super(name, options);
   *       }
   *
   *       async handle(ctx, next) {
   *         try {
   *           const data = await fs.readFile('myfile.txt', 'utf-8');
   *           ctx.res.end(data);
   *         } catch (err) {
   *           ctx.done(err);
   *         }
   *       }
   *     }
   *
   * @param {Context} ctx - The context of the request.
   * @param {Function} next - The next middleware function.
   * @api public
   */
  async handle(ctx, next) {
    // Default implementation does nothing and calls next()
    await next();
  }

  /**
   * Converts a resource constructor into a JSON object.
   * It should at least include the `type` and `defaultPath`.
   *
   * @returns {Object} - The JSON representation of the resource.
   * @api public
   */
  toJSON() {
    return {
      type: this.name,
      defaultPath: this.path || '/my-resource'
    };
  }
}

/**
 * Determines the specificity of a resource based on its path.
 * More segments imply higher specificity.
 *
 * @param {Resource} resource - The resource instance.
 * @returns {Number} - The specificity score.
 * @api private
 */
function specificness(resource) {
  const pathSegments = resource.path && resource.path !== '/' ? resource.path.split('/') : [];
  return pathSegments.length;
}

/**
 * Static property to define external prototype methods.
 * Extend this object to add methods accessible over HTTP and to dpd.js.
 */
ResourceClass.external = {};

/**
 * Static method to define events that the resource can handle.
 * Extend this array with event names.
 */
ResourceClass.events = [];

// Back-compat functional constructor so legacy util.inherits(...) and
// Resource.apply(this, arguments) patterns keep working with the class.
function Resource(name, options) {
  // Initialize EventEmitter state on this instance
  EventEmitter.call(this);
  this.name = name;
  this.path = `/${name}`;
  this.options = options || {};
  this.config = (this.options && this.options.config) || {};
  this.events = {};
  this.external = {};
  if (Resource.external) {
    Object.keys(Resource.external).forEach((key) => {
      if (typeof Resource.external[key] === 'function') {
        this.external[key] = (...args) => {
          Resource.external[key].apply(this, args);
        };
      }
    });
  }
  this.clientGeneration = false;
  this.clientGenerationGet = [];
  this.clientGenerationExec = [];
  this.__resource__ = true;
}

// Share prototype methods with the class implementation
Resource.prototype = ResourceClass.prototype;
Resource.prototype.constructor = Resource;

// Mirror static props
Resource.external = ResourceClass.external;
Resource.events = ResourceClass.events;

// Export the back-compat constructor
module.exports = Resource;
