const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const debug = require('debug')('keys');

/**
 * A collection of keys backed by a JSON file.
 *
 * @class Keys
 */
class Keys {
  /**
   * Creates an instance of Keys.
   *
   * @param {String} [filePath='.dpd/keys.json'] - The path to the keys file.
   */
  constructor(filePath = path.join('.dpd', 'keys.json')) {
    this.path = filePath;
  }

  /**
   * Generates a cryptographically strong pseudo-random key.
   *
   * @returns {String} - The generated key as a hexadecimal string.
   */
  generate() {
    return crypto.randomBytes(256).toString('hex');
  }

  /**
   * Reads the keys file and parses its JSON content.
   *
   * @returns {Promise<Object>} - A promise that resolves to the keys object.
   */
  async readFile() {
    try {
      const data = await fs.readFile(this.path, 'utf-8');
      return JSON.parse(data) || {};
    } catch (err) {
      if (err.code === 'ENOENT') {
        // If file does not exist, return an empty object
        debug(`Keys file not found at "${this.path}". A new file will be created upon key creation.`);
        return {};
      } else {
        debug(`Error reading keys file at "${this.path}": ${err.message}`);
        throw new Error(`Failed to read keys file: ${err.message}`);
      }
    }
  }

  /**
   * Writes the keys object to the keys file in JSON format.
   *
   * @param {Object} data - The keys object to write.
   * @returns {Promise<void>}
   */
  async writeFile(data) {
    try {
      const dir = path.dirname(this.path);
      // Ensure the directory exists
      await fs.mkdir(dir, { recursive: true });
      const jsonStr = JSON.stringify(data, null, 2); // Pretty-print with 2 spaces
      await fs.writeFile(this.path, jsonStr, 'utf-8');
      debug(`Keys successfully written to "${this.path}".`);
    } catch (err) {
      debug(`Error writing keys file at "${this.path}": ${err.message}`);
      throw new Error(`Failed to write keys file: ${err.message}`);
    }
  }

  /**
   * Retrieves a specific key from the keys file.
   *
   * @param {String} key - The key to retrieve.
   * @returns {Promise<String|Boolean>} - The value of the key or undefined if not found.
   */
  async get(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('A valid key string must be provided.');
    }

    const data = await this.readFile();
    return data[key];
  }

  /**
   * Creates a new key and saves it to the keys file.
   *
   * @returns {Promise<String>} - The newly created key.
   */
  async create() {
    const key = this.generate();
    const data = await this.readFile();
    data[key] = true; // You can modify this line based on how you want to store the key's value
    await this.writeFile(data);
    debug(`New key created: ${key}`);
    return key;
  }

  /**
   * Retrieves the first key from the keys file.
   *
   * @returns {Promise<String|undefined>} - The first key or undefined if no keys exist.
   */
  async getLocal() {
    const data = await this.readFile();
    const keys = Object.keys(data);
    return keys.length > 0 ? keys[0] : undefined;
  }
}

module.exports = Keys;
