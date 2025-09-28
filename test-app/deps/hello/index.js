var util = require('util');
var Resource = require('deployd/lib/resource');

function Hello() {
  Resource.apply(this, arguments);
}
util.inherits(Hello, Resource);

Hello.prototype.handle = function(ctx, next) {
  if (ctx && ctx.req && ctx.req.method === 'GET') {
    ctx.done(null, { hello: 'world' });
    return;
  }

  next();
};

Hello.label = 'Hello';
Hello.defaultPath = '/hello';
Hello.prototype.__resource__ = true;

module.exports = Hello;
