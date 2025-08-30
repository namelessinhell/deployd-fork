const InternalClient = require('./internal-client');
const debug = require('debug')('context');
const { createResponder } = require('doh');

/**
 * A `Context` gives access to a `req` and `res` object when passed to `resource.handle()`,
 * as well as several utility functions and properties.
 *
 * Properties:
 * - **req** `ServerRequest` req
 * - **res** `ServerResponse` res
 * - **url** `String` The url of the request, stripped of the resource's base path
 * - **body** `Object` The body of the request, if the body is JSON or url encoded
 * - **query** `Object` The query of the request
 *
 * @class Context
 * @param {Object} resource - The resource handling the request.
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {Object} server - The server instance.
 */
class Context {
  /**
   * Constructs a new Context instance.
   *
   * @param {Object} resource - The resource handling the request.
   * @param {Object} req - The HTTP request object.
   * @param {Object} res - The HTTP response object.
   * @param {Object} server - The server instance.
   */
  constructor(resource, req, res, server) {
    this.req = req || { headers: {}, method: 'GET', url: '' };
    this.res = res || {
      setHeader() {},
      getHeader() { return undefined; },
      end() {},
      headersSent: false,
      statusCode: 200
    };
    this.server = server;
    this.session = (req && req.session) || {};
    this.method = (req && req.method) || 'GET';

    // Extract and normalize the URL relative to the resource's base path
    this.url = this._extractUrl(resource.path, (req && req.url) || '');

    // Parse the request body and query parameters
    this.body = (req && req.body) || {};
    this.query = (req && req.query) || {};

    // Bind the done method to this context
    this.done = this.done.bind(this);

    // Handle recursion limits if specified in query or body
    this._handleRecursionLimit();

    // Initialize the dpd client for internal API interactions
    // Build internal dpd client bound to this context
    try {
      const stack = (this.req && this.req.stack) || [];
      this.dpd = new InternalClient(server, this.session, stack, this).build();
    } catch (e) {
      debug('Failed to build internal client:', e && e.message);
      this.dpd = {};
    }
  }

  /**
   * Extracts and normalizes the URL by removing the resource's base path.
   *
   * @private
   * @param {string} basePath - The base path of the resource.
   * @param {string} fullUrl - The full URL of the request.
   * @returns {string} - The normalized URL.
   */
  _extractUrl(basePath, fullUrl) {
    let relativeUrl = fullUrl.slice(basePath.length);
    if (!relativeUrl.startsWith('/')) relativeUrl = `/${relativeUrl}`;
    return relativeUrl;
  }

  /**
   * Handles the recursion limit based on query or body parameters.
   *
   * @private
   */
  _handleRecursionLimit() {
    const limit = (this.query && this.query.$limitRecursion) || (this.body && this.body.$limitRecursion);
    if (limit !== undefined) {
      this.req.stack = this.req.stack || [];
      this.req.stack.recursionLimit = Number(limit) || 0;
      debug(`Set recursion limit to ${this.req.stack.recursionLimit}`);
    }
  }

  /**
   * Ends the response.
   *
   * @param {...any} args - Arguments to pass to res.end().
   */
  end(...args) {
    this.res.end(...args);
  }

  /**
   * Continuous callback sugar for easily calling res.end().
   *
   * Example:
   *
   *     // instead of
   *     store.find({foo: 'bar'}, function(err, res) {
   *       if(err) return res.end(JSON.stringify(err));
   *       res.end(JSON.stringify(res));
   *     })
   *
   *     // you can just do
   *     store.find({foo: 'bar'}, ctx.done);
   *
   * @param {Error} err - The error object, if any.
   * @param {Object} response - The response data.
   */
  async done(err, response) {
    if (this.res.finished) {
      debug('Response has already been sent.');
      return;
    }

    // Set default status code if not already set
    let statusCode = this.res.statusCode || 200;

    if (err) {
      debug('Handling error:', err);
      statusCode = err.statusCode || 400;
      this.res.statusCode = statusCode;
      createResponder()(err, this.req, this.res);
      return;
    }

    // Determine the response type and content
    let responseBody = response;
    let contentType = 'application/json';

    if (typeof response === 'object' && response !== null) {
      try {
        const seen = new WeakSet();
        responseBody = JSON.stringify(response, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return undefined; // drop circular refs
            seen.add(value);
          }
          return value;
        });
      } catch (serializationError) {
        debug('Failed to serialize response object:', serializationError);
        this.res.statusCode = 500;
        responseBody = JSON.stringify({ message: 'Internal Server Error' });
      }
    } else {
      contentType = 'text/html; charset=utf-8';
      responseBody = response || '';
    }

    // Set necessary headers
    this._setHeaders(statusCode, responseBody, contentType);

    // End the response
    if (![204, 304].includes(statusCode)) {
      this.res.end(responseBody);
    } else {
      this.res.end();
    }
  }

  /**
   * Sets the necessary HTTP headers for the response.
   *
   * @private
   * @param {number} statusCode - The HTTP status code.
   * @param {string|Buffer} body - The response body.
   * @param {string} contentType - The Content-Type header value.
   */
  _setHeaders(statusCode, body, contentType) {
    const headers = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': contentType
    };

    if (![204, 304].includes(statusCode) && body) {
      headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    }

    Object.entries(headers).forEach(([header, value]) => {
      if (!this.res.headersSent && !this.res.getHeader(header)) {
        this.res.setHeader(header, value);
      }
    });
  }
}

module.exports = Context;
