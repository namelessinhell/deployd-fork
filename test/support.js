/**
 * Dependencies
 */

global.expect = require('chai').expect;
const http = require('http');
const { MongoClient } = require('mongodb');
const Stream = require('stream');
const sh = require('shelljs');
const debug = require('debug')('test:support');

if (typeof String.prototype.to !== 'function') {
  Object.defineProperty(String.prototype, 'to', {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function (file) {
      return sh.ShellString(String(this)).to(file);
    }
  });
}

if (typeof String.prototype.toEnd !== 'function') {
  Object.defineProperty(String.prototype, 'toEnd', {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function (file) {
      return sh.ShellString(String(this)).toEnd(file);
    }
  });
}
// Maintain backwards compatible globals for tests that rely on them.
global.sh = sh;

global.http = http;
global.TEST_DB = { name: 'test-db', host: 'localhost', port: 27017 };

const TEST_DB_URI = process.env.DPD_TEST_DB_URI || `mongodb://${TEST_DB.host}:${TEST_DB.port}/${TEST_DB.name}`;

// port generation
function genPort() {
  var min = 6666, max = 9999;
  var result = min + (Math.random() * (max - min));
  return Math.floor(result);
}
global.genPort = genPort;

function sendHttpRequest(options, callback) {
  var parsed = new URL(options.url);
  var requestOptions = {
    method: options.method || 'GET',
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + (parsed.search || ''),
    headers: Object.assign({}, options.headers || {})
  };

  var payload = options.body;
  var isStream = payload instanceof Stream;
  if (options.json && payload && !isStream) {
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      payload = JSON.stringify(payload);
    }
    requestOptions.headers['Content-Type'] = requestOptions.headers['Content-Type'] || 'application/json';
  }

  if (payload && !isStream && typeof payload === 'string') {
    requestOptions.headers['Content-Length'] = Buffer.byteLength(payload);
  } else if (payload && Buffer.isBuffer(payload)) {
    requestOptions.headers['Content-Length'] = payload.length;
  }

  var req = http.request(requestOptions, function (res) {
    var chunks = [];
    res.on('data', function (chunk) { chunks.push(chunk); });
    res.on('end', function () {
      var bodyBuffer = Buffer.concat(chunks);
      var body = bodyBuffer.toString();
      if (options.json && body.length) {
        try {
          res.body = JSON.parse(body);
        } catch (err) {
          res.body = body;
        }
      } else if (options.json && !body.length) {
        res.body = null;
      } else {
        res.body = body;
      }
      callback(null, res, res.body);
    });
  });

  req.on('error', function (err) {
    callback(err);
  });

  if (payload) {
    if (isStream) {
      payload.pipe(req);
      return;
    }
    if (Buffer.isBuffer(payload)) {
      req.write(payload);
    } else {
      req.write(String(payload));
    }
  }

  req.end();
}

global.freq = function (url, options, fn, callback) {
  var port = genPort();
  options = options || {};
  options.url = 'http://localhost:' + port + url;
  var server = http.createServer(function (req, res) {
    if (callback) {
      var end = res.end;
      res.end = function () {
        var result = end.apply(res, arguments);
        server.close();
        return result;
      };
    } else {
      server.close();
    }
    fn(req, res);
  })
  .listen(port)
  .on('listening', function () {
    sendHttpRequest(options, function () {
      if (callback) {
        callback.apply(null, arguments);
      }
    });
  });
};

before(function (done) {
  var client = new MongoClient(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });

  function isIgnorableMongoError(err) {
    if (!err) { return false; }
    if (err.name === 'MongoServerSelectionError') { return true; }
    if (err.code === 'ECONNREFUSED') { return true; }
    var message = String(err.message || '');
    if (/ECONNREFUSED/.test(message)) { return true; }
    if (err.codeName === 'NamespaceNotFound' || /ns not found/i.test(message)) { return true; }
    return false;
  }

  client.connect()
    .then(function () {
      return client.db(TEST_DB.name).dropDatabase();
    })
    .then(function () { return client.close(); })
    .then(function () { done(); })
    .catch(function (err) {
      if (isIgnorableMongoError(err)) {
        debug('Skipping database cleanup because MongoDB is unavailable');
        client.close().catch(function () {});
        done();
        return;
      }
      client.close().catch(function () {}).then(function () { done(err); });
    });
});

/**
 * Utility for easily testing resources with mock contexts
 *
 * Inputs:
 *  - url (relative to the base path)
 *  - query object
 *  - body object or stream
 *  - headers object
 *  - method (get,post,put,delete,etc)
 *
 * Output:
 *   Should be what context.done should be called with
 *
 * Behavior:
 *  - error true if should expect an error
 *  - next should call next if
 */

var ServerRequest = require('http').ServerRequest,
  ServerResponse = require('http').ServerResponse;

global.fauxContext = function(resource, url, input, expectedOutput, behavior) {
  input = input || {};
  var context = {
    url: url,
    body: input.body,
    query: input.query,
    done: function(err, res) {
      if(behavior && behavior.next) throw new Error('should not call done');
      if(expectedOutput && typeof expectedOutput == 'object') expect(res).to.eql(expectedOutput);
      context.done = function() {
        throw 'done called twice...';
      };
      if(behavior && behavior.done) behavior.done(err, res);
    },
    res: input.res || new ServerResponse(new ServerRequest())
  };

  context.res.end = function() {
    context.done();
  };

  function next(err) {
    if(!(behavior && behavior.next)) {
      throw new Error('should not call next');
    }
    if(behavior && behavior.done) behavior.done(err);
  }

  resource.handle(context, next);
};





