var http = require('http');
var https = require('https');
var url = require('url');
var util = require('util');
var Resource = require('deployd/lib/resource');

function Proxy() {
  Resource.apply(this, arguments);
}
util.inherits(Proxy, Resource);

Proxy.prototype.handle = function(ctx, next) {
  var remote = this.config && this.config.remote;
  if (!remote) {
    return next();
  }

  if (!ctx || !ctx.req) {
    return next();
  }

  var suffix = ctx.url || '/';
  if (suffix.charAt(0) !== '/') {
    suffix = '/' + suffix;
  }

  var targetUrl = new url.URL(suffix, remote);
  var headers = Object.assign({}, ctx.req.headers || {});
  headers.host = targetUrl.hostname;

  var options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: ctx.req.method,
    headers: headers
  };

  var transport = options.protocol === 'https:' ? https : http;
  var proxyReq = transport.request(options, function(proxyRes) {
    var chunks = [];
    proxyRes.on('data', function(chunk) {
      chunks.push(chunk);
    });
    proxyRes.on('end', function() {
      var bodyBuffer = Buffer.concat(chunks);
      var contentType = proxyRes.headers['content-type'] || '';
      if (/application\/json/i.test(contentType)) {
        try {
          var jsonBody = JSON.parse(bodyBuffer.toString('utf8'));
          ctx.res.statusCode = proxyRes.statusCode;
          Object.keys(proxyRes.headers || {}).forEach(function(header) {
            ctx.res.setHeader(header, proxyRes.headers[header]);
          });
          ctx.done(null, jsonBody);
          return;
        } catch (err) {
          // fall through to send raw body
        }
      }
      ctx.res.statusCode = proxyRes.statusCode;
      Object.keys(proxyRes.headers || {}).forEach(function(header) {
        ctx.res.setHeader(header, proxyRes.headers[header]);
      });
      ctx.res.end(bodyBuffer);
    });
  });

  proxyReq.on('error', function(err) {
    ctx.done(err);
  });

  if (ctx.body && ['POST', 'PUT', 'PATCH'].indexOf(options.method) !== -1) {
    var payload;
    if (Buffer.isBuffer(ctx.body)) {
      payload = ctx.body;
    } else if (typeof ctx.body === 'string') {
      payload = Buffer.from(ctx.body);
    } else {
      payload = Buffer.from(JSON.stringify(ctx.body));
      if (!proxyReq.getHeader('content-type')) {
        proxyReq.setHeader('content-type', 'application/json');
      }
    }
    proxyReq.write(payload);
  }

  proxyReq.end();
};

Proxy.label = 'Proxy';
Proxy.defaultPath = '/proxy';
Proxy.prototype.__resource__ = true;

module.exports = Proxy;
