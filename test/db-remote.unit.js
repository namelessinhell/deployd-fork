var fs = require('fs')
  , db = require('../lib/db')
  , config = require(__dirname + '/support/db-remote.config.json')
  , tester = db.create(config)
  , store = tester.createStore('test-store')
  , assert = require('assert')
  , MongoClient = require('mongodb').MongoClient;

var client;
var database;

function buildConnectionUri() {
  return `mongodb://${config.host}:${config.port}`;
}

function ignoreNamespace(err) {
  if (!err) return;
  if (err.codeName === 'NamespaceNotFound') return;
  if (err.codeName === 'UserNotFound') return;
  if (err.code === 11) return;
  if (/ns not found/i.test(err.message)) return;
  if (/User '[^']+' not found/.test(err.message)) return;
  throw err;
}

before(function(done){
  client = new MongoClient(buildConnectionUri(), { serverSelectionTimeoutMS: 2000 });
  client.connect()
    .then(function () {
      database = client.db(config.name);
      return database.removeUser(config.credentials.username).catch(ignoreNamespace);
    })
    .then(function () {
      return database.addUser(config.credentials.username, config.credentials.password);
    })
    .then(function () { done(); })
    .catch(done);
});

after(function(done){
  var sequence = Promise.resolve();
  if (database) {
    sequence = sequence.then(function () {
      return database.removeUser(config.credentials.username).catch(ignoreNamespace);
    });
  }
  sequence
    .then(function () { return client ? client.close() : null; })
    .then(function () { done(); })
    .catch(done);
});

beforeEach(function(done){
  store.remove(function () {
    store.find(function (err, result) {
      assert.equal(err, null);
      assert.equal(result.length, 0);
      done(err);
    });
  });
});

describe('db', function(){
  describe('.create(options)', function(){
    it('should connect to a remote database', function(done) {
      store.find(function (err, empty) {
        assert.equal(empty.length, 0);
        done(err);
      });
    });
  });
});

describe('store', function(){

  describe('.find(query, fn)', function(){
    it('should not find anything when the store is empty', function(done) {
      store.find(function (err, empty) {
        assert.equal(empty.length, 0);
        done(err);
      });
    });

    it('should pass the query to the underlying database', function(done) {
      store.insert([{i:1},{i:2},{i:3}], function () {
        store.find({i: {$lt: 3}}, function (err, result) {
          assert.equal(result.length, 2);
          result.forEach(function (obj) {
            assert.equal(typeof obj.id, 'string');
          });
          done(err);
        });
      });
    });

    // TODO: convert the rest of the tests
  });
});

