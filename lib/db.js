const util = require('util');
const EventEmitter = require('events').EventEmitter;
const { MongoClient, ObjectId } = require('mongodb'); // Updated import for MongoDB v4
const uuid = require('./util/uuid');
const validator = require('validator'); // Replaced 'scrubber' with 'validator'
const debug = require('debug')('db');
const url = require('url');
const _ = require('lodash');

// Enable detailed error logging for the database
require('debug').enable('db:error');
const error = require('debug')('db:error');

/**
 * Exported db module
 */
const db = module.exports = {};

/**
 * Create a new database instance with the given options.
 *
 * Options:
 *   - `name`         The database name
 *   - `host`         The database host
 *   - `port`         The database port
 *   - `credentials`  An object containing `username` and `password` for authentication
 *
 * Example:
 *
 *     db
 *       .create({host: 'localhost', port: 27017, name: 'test'})
 *       .createStore('testing-store')
 *       .insert({foo: 'bar'}, fn)
 *
 * @param {Object} options
 * @return {Db}
 */
db.create = function (options) {
  const dbInstance = new Db(options);
  return dbInstance;
};

/**
 * A `Db` abstracts a driver implementation of the database. This allows for
 * a single interface to be used against any database implementation.
 *
 * @param {Object} options
 * @api private
 */
class Db extends EventEmitter {
  /**
   * Constructor for the Db class.
   *
   * @param {Object} options
   */
  constructor(options) {
    super();
    this.options = options;
    this.connectionString = this.options.connectionString;

    // Enhanced connection pooling configuration for better performance
    this.connectionOptions = {
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      retryReads: true,
      ...this.options.connectionOptions
    };

    if (!this.connectionString && this.options.host) {
      const authPart = this.options.credentials
        ? `${encodeURIComponent(this.options.credentials.username)}:${encodeURIComponent(this.options.credentials.password)}@`
        : '';
      this.connectionString = `mongodb://${authPart}${this.options.host}:${this.options.port}/${this.options.name}`;
    }

    this.client = new MongoClient(this.connectionString, this.connectionOptions);
    this.connected = false;

    // Initialize the connection
    this.initConnection();
  }

  /**
   * Initialize the MongoDB connection.
   */
  async initConnection() {
    try {
      await this.client.connect();
      this.db = this.client.db(this.options.name);
      this.connected = true;
      debug('MongoDB connected successfully');
      this.emit('connected');
    } catch (err) {
      error(`MongoDB connection error: ${err.message}`);
      this.emit('error', err);
      // Do not exit the process in library code; allow caller to handle
      this.connected = false;
    }
  }

  /**
   * Drop the underlying database.
   *
   * @return {Promise<void>}
   */
  async drop() {
    if (!this.connected) {
      throw new Error('Database not connected');
    }
    try {
      await this.db.dropDatabase();
      debug('Database dropped successfully');
    } catch (err) {
      error(`Error dropping database: ${err.message}`);
      throw err;
    }
  }

  /**
   * Create a new database store (e.g., a collection).
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .insert({foo: 'bar'}, fn)
   *
   * @param {String} namespace
   * @return {Store}
   */
  createStore(namespace) {
    return new Store(namespace, this);
  }

  /**
   * Close the database connection.
   *
   * @return {Promise<void>}
   */
  async close() {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
      debug('MongoDB connection closed');
    }
  }
}

db.Db = Db;

/**
 * Initialize a space in the database (e.g., a collection).
 *
 * @param {String} namespace
 * @param {Db} dbInstance
 * @api private
 */
class Store {
  /**
   * Constructor for the Store class.
   *
   * @param {String} namespace
   * @param {Db} dbInstance
   */
  constructor(namespace, dbInstance) {
    this.namespace = namespace;
    this._db = dbInstance;
  }

  /**
   * Get the MongoDB collection associated with this store.
   *
   * @return {Promise<Collection>}
   */
  async getCollection() {
    if (!this._db.connected) {
      await new Promise((resolve, reject) => {
        this._db.once('connected', resolve);
        this._db.once('error', reject);
      });
    }
    return this._db.db.collection(this.namespace);
  }

  /**
   * Change public IDs to private IDs.
   *
   * IDs are generated with a pseudo-random number generator.
   * 24 hexadecimal chars, ~2 trillion combinations.
   *
   * @param {Object|Array} object
   * @return {Object|Array}
   * @api private
   */
  identify(object) {
    if (!object) return;
    if (typeof object !== 'object') throw new Error('identify requires an object');

    const set = (obj) => {
      if (obj._id) {
        obj.id = obj._id.toString();
        delete obj._id;
      } else {
        const u = obj.id ? new ObjectId(obj.id) : new ObjectId(this.createUniqueIdentifier());
        obj._id = u;
        delete obj.id;
      }
    };

    if (Array.isArray(object)) {
      object.forEach(set);
    } else {
      set(object);
    }
    return object;
  }

  /**
   * Change query IDs to private IDs.
   *
   * @param {Object} query
   * @return {Object}
   * @api private
   */
  scrubQuery(query) {
    if (query.id && typeof query.id === 'object') {
      query._id = query.id;
      delete query.id;
    }

    try {
      // Optimized query sanitization - only process string values
      for (const key in query) {
        if (query.hasOwnProperty(key) && typeof query[key] === 'string') {
          query[key] = validator.escape(query[key]);
        }
      }
    } catch (ex) {
      debug(`Error sanitizing query: ${ex.message}`);
    }

    return query;
  }

  /**
   * Create a unique identifier. Override this in derived stores
   * to change the way IDs are generated.
   *
   * @return {String}
   */
  createUniqueIdentifier() {
    return uuid.create();
  }

  /**
   * Insert an object into the store.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .insert({foo: 'bar'}, fn)
   *
   * @param {Object|Array} object
   * @param {Function} callback(err, obj)
   */
  async insert(object, callback) {
    if (Array.isArray(object) && object.length === 0) {
      // MongoDB does not allow inserting empty arrays
      if (callback) callback(null, null);
      return;
    }

    try {
      this.identify(object);
      const collection = await this.getCollection();
      let result;
      if (Array.isArray(object)) {
        result = await collection.insertMany(object);
        const inserted = result.insertedIds ? Object.values(result.insertedIds).map((id) => ({ _id: id })) : [];
        callback(null, inserted.map((doc) => this.identify(doc)));
      } else {
        result = await collection.insertOne(object);
        const inserted = { _id: result.insertedId };
        callback(null, this.identify(inserted));
      }
    } catch (err) {
      error(`Insert error: ${err.message}`);
      if (callback) callback(err);
    }
  }

  /**
   * Find the number of objects in the store that match the given query.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .count({foo: 'bar'}, fn)
   *
   * @param {Object} query
   * @param {Function} callback(err, num)
   */
  async count(query, callback) {
    if (typeof query === 'function') {
      callback = query;
      query = {};
    } else {
      this.scrubQuery(query);
    }

    try {
      const collection = await this.getCollection();
      const count = await collection.countDocuments(query);
      callback(null, count);
    } catch (err) {
      error(`Count error: ${err.message}`);
      callback(err);
    }
  }

  /**
   * Find all objects in the store that match the given query.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .find({foo: 'bar'}, fn)
   *
   * @param {Object} query
   * @param {Function} callback(err, obj)
   */
  async find(query, callback) {
    if (typeof query === 'function') {
      callback = query;
      query = {};
    } else {
      this.scrubQuery(query);
    }

    try {
      const collection = await this.getCollection();
      const cursor = collection.find(query);

      const docs = await cursor.toArray();
      const identifiedDocs = docs.map((doc) => this.identify(doc));
      callback(null, identifiedDocs);
    } catch (err) {
      error(`Find error: ${err.message}`);
      callback(err);
    }
  }

  /**
   * Find the first object in the store that matches the given query.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .first({foo: 'bar'}, fn)
   *
   * @param {Object} query
   * @param {Function} callback(err, obj)
   */
  async first(query, callback) {
    if (typeof query === 'function') {
      callback = query;
      query = {};
    } else {
      this.scrubQuery(query);
    }

    try {
      const collection = await this.getCollection();
      const doc = await collection.findOne(query);
      const identifiedDoc = this.identify(doc);
      callback(null, identifiedDoc);
    } catch (err) {
      error(`First error: ${err.message}`);
      callback(err);
    }
  }

  /**
   * Update an object or objects in the store that match the given query.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .update({id: '<an object id>'}, {foo: 'new value'}, fn)
   *
   * @param {Object} query
   * @param {Object} update
   * @param {Function} callback(err, result)
   */
  async update(query, update, callback) {
    let multi = false;

    if (typeof query === 'string') {
      query = { id: query };
    }
    if (typeof query !== 'object') {
      const errMsg = 'Update requires a query object or string id';
      error(errMsg);
      throw new Error(errMsg);
    }
    if (query.id) {
      this.identify(query);
    } else {
      multi = true;
    }

    this.scrubQuery(query);

    // Separate update operators from the update object
    const operators = {};
    const setFields = {};

    Object.keys(update).forEach((key) => {
      if (key.startsWith('$')) {
        operators[key] = update[key];
      } else {
        setFields[key] = update[key];
      }
    });

    if (Object.keys(setFields).length > 0) {
      operators.$set = setFields;
    }

    try {
      const collection = await this.getCollection();
      let result;
      if (multi) {
        result = await collection.updateMany(query, operators);
      } else {
        result = await collection.updateOne(query, operators);
      }
      callback(null, { modifiedCount: result.modifiedCount });
    } catch (err) {
      error(`Update error: ${err.message}`);
      callback(err);
    }
  }

  /**
   * Remove an object or objects in the store that match the given query.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .remove({id: '<an object id>'}, fn)
   *
   * @param {Object} query
   * @param {Function} callback(err, result)
   */
  async remove(query, callback) {
    if (typeof query === 'string') {
      query = { id: query };
    }
    if (typeof query === 'function') {
      callback = query;
      query = {};
    }
    if (query.id) {
      this.identify(query);
    }

    try {
      const collection = await this.getCollection();
      let result;
      if (query.id) {
        result = await collection.deleteOne(query);
      } else {
        result = await collection.deleteMany(query);
      }
      callback(null, { deletedCount: result.deletedCount });
    } catch (err) {
      error(`Remove error: ${err.message}`);
      callback(err);
    }
  }

  /**
   * Rename the store.
   *
   * Example:
   *
   *     db
   *       .create({host: 'localhost', port: 27017, name: 'test'})
   *       .createStore('testing-store')
   *       .rename('renamed-store', fn)
   *
   * @param {String} newNamespace
   * @param {Function} callback(err, result)
   */
  async rename(newNamespace, callback) {
    try {
      const collection = await this.getCollection();
      await collection.rename(newNamespace);
      this.namespace = newNamespace;
      callback(null, { renamed: true });
    } catch (err) {
      error(`Rename error: ${err.message}`);
      callback(err);
    }
  }
}

/**
 * Strip fields from the query object.
 *
 * @param {Object} query
 * @return {Object|undefined}
 */
function stripFields(query) {
  if (!query) return undefined;
  const fields = query.$fields;
  if (fields) delete query.$fields;
  return fields;
}

/**
 * Strip options from the query object and convert them to MongoDB find options.
 *
 * @param {Object} query
 * @return {Object}
 */
function stripOptions(query) {
  const options = {};
  if (!query) return options;

  if (query.$limit) options.limit = parseInt(query.$limit, 10);
  if (query.$skip) options.skip = parseInt(query.$skip, 10);
  if (query.$sort || query.$orderby) {
    options.sort = query.$sort || query.$orderby;
  }

  delete query.$limit;
  delete query.$skip;
  delete query.$sort;
  delete query.$orderby;

  return options;
}

module.exports.Store = Store;
