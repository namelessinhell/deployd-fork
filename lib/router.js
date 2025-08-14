const path = require('path');
const debug = require('debug')('router');
const doh = require('doh');
const EventEmitter = require('events').EventEmitter;
const async = require('async');
const _ = require('lodash'); // Replaced 'underscore' with 'lodash'

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

      // Process each matching resource sequentially
      await async.eachSeries(matchingResources, async (resource) => {
        const ctx = new Context(resource, req, res, this.server);
        ctx.router = this;

        // Set isRoot flag based on authentication
        if (ctx.session) ctx.session.isRoot = req.isRoot || false;

        // Extract the path without leading '/'
        const furl = ctx.url.replace('/', '');

        // Handle external functions if defined
        if (resource.external && typeof resource.external[furl] === 'function') {
          await resource.external[furl](ctx.body, ctx, ctx.done);
        } else {
          // Execute the resource handler
          await resource.handle(ctx, () => Promise.resolve());
        }
      });

      // If no resource handled the request, respond with 404
      if (matchingResources.length === 0) {
        this.handle404(req, res);
      }
    } catch (err) {
      debug(`Error during routing: ${err.message}`);
      console.error(err.stack || err);
      res.statusCode = err.statusCode || 500;
      res.end(err.message || 'Internal Server Error');
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
    const sanitizedPath = resourcePath && resourcePath !== '/' ? resourcePath : '';
    const escapedPath = sanitizedPath.replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&');
    return new RegExp(`^${escapedPath}(?:[/?].*)?$`);
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
