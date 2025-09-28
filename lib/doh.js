var EventEmitter = require('events').EventEmitter;

function createResponder() {
  return function respond(err, req, res) {
    if (!err || !res || res.writableEnded) {
      return;
    }

    var status = normalizeStatus(err);
    if (status === 500 && res && typeof res.statusCode === 'number' && res.statusCode >= 400 && res.statusCode < 600) {
      status = res.statusCode;
    }
    var payload = normalizePayload(err);

    try {
      if (!res.headersSent) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      var body = JSON.stringify(payload);
      res.end(body);
    } catch (responseError) {
      safeEnd(res);
    }
  };
}

function createHandler(options) {
  options = options || {};
  var req = options.req;
  var res = options.res;
  var server = options.server;
  var emitter = server instanceof EventEmitter ? server : null;
  var finished = false;

  function handleError(err) {
    if (!err || finished) {
      return;
    }
    finished = true;

    if (emitter) {
      emitter.emit('request:error', err, req, res);
    }

    var responder = createResponder();
    responder(err, req, res);
  }

  return {
    run: function(fn) {
      if (finished || typeof fn !== 'function') {
        return;
      }

      try {
        var result = fn();
        if (result && typeof result.then === 'function') {
          result.catch(handleError);
        }
      } catch (err) {
        handleError(err);
      }
    }
  };
}

function upgrade(server) {
  if (!server || typeof server.on !== 'function') {
    return server;
  }

  server.on('request', function(req, res) {
    function handleError(err) {
      if (!err) {
        return;
      }
      if (typeof server.emit === 'function') {
        server.emit('request:error', err, req, res);
      }
    }

    req.on('error', handleError);
    res.on('error', handleError);
  });

  return server;
}

function safeEnd(res) {
  try {
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    // noop
  }
}

function normalizeStatus(err) {
  var status = err && (err.statusCode || err.status);
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return status;
  }
  return 500;
}

function normalizePayload(err) {
  if (!err) {
    return { message: 'Unknown error' };
  }

  if (typeof err === 'string') {
    return { message: err };
  }

  if (err instanceof Error) {
    var payload = { message: err.message };
    if (err.code) {
      payload.code = err.code;
    }
    if (err.errors) {
      payload.errors = err.errors;
    }
    return payload;
  }

  if (typeof err === 'object') {
    return Object.assign({ message: 'Request failed' }, err);
  }

  return { message: String(err) };
}

module.exports = {
  createResponder: createResponder,
  createHandler: createHandler,
  upgrade: upgrade
};
