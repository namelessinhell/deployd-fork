var fs = require('fs')
  , db = require('../lib/db')
  , config = require(__dirname + '/support/db-remote.config.json')
  , tester = db.create(config)
  , store = tester.createStore('test-store')
  , assert = require('assert')
  , { MongoClient } = require('mongodb');

var mdb;
var client;

before(async function(){
  try {
    const connectionString = `mongodb://${config.credentials.username}:${config.credentials.password}@${config.host}:${config.port}/${config.name}`;
    client = new MongoClient(connectionString);
    await client.connect();
    mdb = client.db(config.name);

    // Note: User management is now handled differently in MongoDB v6
    // The test assumes the user already exists or authentication is handled differently
  } catch (err) {
    console.error('Failed to connect to test database:', err);
    console.log('Skipping remote database tests due to connection failure');
    this.skip();
  }
});

after(async function(){
  if (client) {
    await client.close();
  }
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
