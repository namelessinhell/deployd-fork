const path = require('path');
const debug = require('debug')('router');
const doh = require('doh');
const EventEmitter = require('events').EventEmitter;
const async = require('async');
const _ = require('lodash'); // Replaced 'underscore' with 'lodash'
const Context = require('./context');

/**
 * Default 404 responder using Doh.
 */
const error404 = doh.createResponder();

/**
 * A `Router` routes incoming requests to the correct resource. It also initializes and
 * executes the correct methods on a resource.
 *
 * @class Router
 * @param {Array<Resource>} resources - The array of resource instances.
 * @param {Server} server - The server instance.
 */
class Router {
  constructor(resources = [], server) {
    this.resources = resources;
    this.server = server;

    // Performance optimization: Cache compiled route patterns
    this.routeCache = new Map();
    this.lastResourceUpdate = 0;
    this.pathRegexCache = new Map();
  }

  /**
   * Routes requests to resources with matching root paths.
   * Generates a `ctx` object and hands it to the resource, along with the `res` by calling its `resource.handle(ctx, next)` method.
   * If a resource calls `next()`, move on to the next resource.
   *
   * If all matching resources call next(), or if the router does not find a resource, respond with `404`.
   *
   * @param {ServerRequest} req - The incoming HTTP request.
   * @param {ServerResponse} res - The HTTP response.
   * @param {Function} [next] - The next middleware function.
   * @api public
   */
  async route(req, res, next) {
    if (req._routed) {
      return;
    }

    req._routed = true;

    try {
      // Handle session for all resources that require it
      await this.handleSessions();

      // Find matching resources for the current URL
      const matchingResources = this.matchResources(req.url);

      let handled = false;

      for (const resource of matchingResources) {
        if (handled || res.writableEnded) break;

        const ctx = new Context(resource, req, res, this.server);
        ctx.router = this;

        // Set isRoot flag based on authentication
        if (ctx.session) ctx.session.isRoot = req.isRoot || false;

        // Extract the path without leading '/'
        const furl = ctx.url.replace('/', '');

        let nextRequested = false;

        await new Promise((resolve, reject) => {
          let settled = false;

          function cleanup() {
            res.removeListener('finish', onResponseDone);
            res.removeListener('close', onResponseDone);
          }

          function onResponseDone() {
            if (settled) return;
            settled = true;
            handled = true;
            cleanup();
            resolve();
          }

          res.once('finish', onResponseDone);
          res.once('close', onResponseDone);

          const originalDone = ctx.done;
          ctx.done = async (...args) => {
            if (settled) return;
            try {
              await originalDone(...args);
              handled = true;
              settled = true;
              cleanup();
              resolve();
            } catch (err) {
              settled = true;
              cleanup();
              reject(err);
            }
          };

          const next = (err) => {
            if (settled) return;
            nextRequested = true;
            settled = true;
            cleanup();
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };

          const invokeHandler = (fn) => {
            try {
              const result = fn();
              if (result && typeof result.then === 'function') {
                result.then(() => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  resolve();
                }).catch((err) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  reject(err);
                });
              }
            } catch (err) {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            }
          };

          if (resource.external && typeof resource.external[furl] === 'function') {
            invokeHandler(() => resource.external[furl](ctx.body, ctx, ctx.done));
          } else {
            invokeHandler(() => resource.handle(ctx, next));
          }
        });

        if (nextRequested) {
          continue;
        }

        if (handled || res.writableEnded || res.headersSent) {
          break;
        }
      }

      if (!handled && !res.writableEnded && !res.headersSent) {
        this.handle404(req, res);
      }
    } catch (err) {
      debug(`Error during routing: ${err && err.message ? err.message : err}`);
      console.error(err && (err.stack || err));
      const responder = doh.createResponder();
      // Ensure non-Error values are handled sensibly
      const wrapped = err instanceof Error ? err : { message: String(err || 'Internal Server Error'), statusCode: 500 };
      res.statusCode = wrapped.statusCode || 500;
      responder(wrapped, req, res);
    }
  }

  /**
   * Handles sessions for all resources that require session handling.
   *
   * @returns {Promise<void>}
   * @private
   */
  handleSessions() {
    return new Promise((resolve, reject) => {
      async.forEach(this.resources, (resource, cb) => {
        if (resource.handleSession) {
          const ctx = new Context(resource, null, null, this.server);
          resource.handleSession(ctx, cb);
        } else {
          cb();
        }
      }, (err) => {
        if (err) {
          debug(`Error handling sessions: ${err.message}`);
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Handles a 404 Not Found response.
   *
   * @param {ServerRequest} req - The incoming HTTP request.
   * @param {ServerResponse} res - The HTTP response.
   * @private
   */
  handle404(req, res) {
    debug(`404 Not Found: ${req.url}`);
    res.statusCode = 404;
    error404({ message: 'Resource not found' }, req, res);
  }

  /**
   * Gets resources whose base path matches the incoming URL, and orders by specificity.
   * (So that /foo/bar will handle a request before /foo)
   *
   * @param {String} url - The URL to match against resource paths.
   * @returns {Array<Resource>} - The array of matching resources sorted by specificity.
   * @api private
   */
  matchResources(url) {
    if (!this.resources || !this.resources.length) return [];

    // Check if we need to rebuild the cache (resources changed)
    if (this.lastResourceUpdate !== this.resources.length) {
      this.routeCache.clear();
      this.lastResourceUpdate = this.resources.length;
    }

    // Check cache first
    if (this.routeCache.has(url)) {
      return this.routeCache.get(url);
    }

    // Filter resources that match the URL
    const matched = this.resources.filter(resource => {
      const regex = this.generateRegex(resource.path);
      return regex.test(url);
    });

    // Sort resources by specificity (longer paths first)
    const result = matched.sort((a, b) => specificness(b) - specificness(a));

    // Cache the result (limit cache size to prevent memory leaks)
    if (this.routeCache.size < 1000) {
      this.routeCache.set(url, result);
    }

    return result;
  }

  /**
   * Generates a regular expression from a base path.
   *
   * @param {String} resourcePath - The base path of the resource.
   * @returns {RegExp} - The generated regular expression.
   * @api private
   */
  generateRegex(resourcePath) {
    const key = resourcePath && resourcePath !== '/' ? resourcePath : '';
    let cached = this.pathRegexCache.get(key);
    if (cached) return cached;
    const escapedPath = key.replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`^${escapedPath}(?:[/?].*)?$`);
    if (this.pathRegexCache.size < 2000) {
      this.pathRegexCache.set(key, regex);
    }
    return regex;
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

module.exports = Router;
