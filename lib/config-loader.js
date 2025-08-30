const fs = require('fs').promises;
const path = require('path');
const debug = require('debug')('config-loader');
const InternalResources = require('./resources/internal-resources');
const Files = require('./resources/files');

/**
 * Loads resources from a project folder.
 *
 * @class ConfigLoader
 */
class ConfigLoader {
  /**
   * Creates an instance of ConfigLoader.
   *
   * @param {Object} server - The server instance.
   */
  constructor(server) {
    this.server = server;
    this.resourceCache = (server && server.__resourceCache) || [];
  }

  /**
   * Loads the configuration by loading types, resource directories, resources, and internal resources.
   *
   * @param {string} basepath - The base path of the project.
   * @returns {Promise<Array<Object>>} - A promise that resolves with the loaded resources.
   */
  async loadConfig(basepath) {
    if (this.resourceCache.length) {
      debug('Loading from cache');
      return this.resourceCache;
    }

    try {
      const types = await this.loadTypes(basepath);
      const resourceDirs = await this.loadResourceDir(basepath);
      const loadedResources = await this.loadResources(types, basepath, resourceDirs);
      const internalResources = await this.addInternalResources(types, basepath, loadedResources);

      if (this.server.options && this.server.options.env !== 'development') {
        this.server.__resourceCache = internalResources;
      }

      return internalResources;
    } catch (error) {
      debug('Error loading configuration:', error);
      throw error;
    }
  }

  /**
   * Loads types using the type-loader module.
   *
   * @returns {Promise<Object>} - A promise that resolves with the combined types.
   */
  async loadTypes(basepath) {
    const _loadTypes = require('./type-loader'); // Lazy load to prevent circular dependencies
    try {
      const result = await _loadTypes(basepath || '.');
      const { defaults = {}, types = {} } = result || {};
      return { ...defaults, ...types };
    } catch (error) {
      debug('Error loading types:', error);
      throw new Error(`Failed to load types: ${error.message}`);
    }
  }

  /**
   * Loads resource directories by finding all config.json files within the resources folder.
   *
   * @param {string} basepath - The base path of the project.
   * @returns {Promise<Array<string>>} - A promise that resolves with the list of resource directories.
   */
  async loadResourceDir(basepath) {
    const resourceDir = path.join(basepath, 'resources');
    try {
      const files = await this.recursiveReadDir(resourceDir, 'config.json');
      const folders = files.map(file => path.relative(resourceDir, path.dirname(file)).split(path.sep).join('/'));
      return folders;
    } catch (error) {
      debug('Error loading resource directory:', error);
      throw new Error(`Failed to load resource directory: ${error.message}`);
    }
  }

  /**
   * Recursively reads a directory and finds all files matching the target filename.
   *
   * @param {string} dir - The directory to read.
   * @param {string} targetFilename - The filename to search for.
   * @returns {Promise<Array<string>>} - A promise that resolves with the list of matching file paths.
   */
  async recursiveReadDir(dir, targetFilename) {
    let results = [];
    try {
      const list = await fs.readdir(dir, { withFileTypes: true });
      for (const dirent of list) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          const res = await this.recursiveReadDir(fullPath, targetFilename);
          results = results.concat(res);
        } else if (dirent.isFile() && dirent.name === targetFilename) {
          results.push(fullPath);
        }
      }
      return results;
    } catch (error) {
      if (error.code === 'ENOENT') {
        debug(`Directory not found: ${dir}`);
        return results; // Return empty array if directory does not exist
      }
      throw error;
    }
  }

  /**
   * Loads resources based on the resource directories.
   *
   * @param {Object} types - The loaded types.
   * @param {string} basepath - The base path of the project.
   * @param {Array<string>} resourceDirs - The list of resource directories.
   * @returns {Promise<Array<Object>>} - A promise that resolves with the list of loaded resources.
   */
  async loadResources(types, basepath, resourceDirs) {
    const resources = [];
    for (const resourceName of resourceDirs) {
      try {
        const resource = await this.initializeResource(types, basepath, resourceName);
        resources.push(resource);
      } catch (error) {
        debug(`Error loading resource "${resourceName}":`, error);
        throw error;
      }
    }
    return resources;
  }

  /**
   * Initializes a single resource by reading its config.json and creating an instance.
   *
   * @param {Object} types - The loaded types.
   * @param {string} basepath - The base path of the project.
   * @param {string} resourceName - The name of the resource.
   * @returns {Promise<Object>} - A promise that resolves with the initialized resource.
   */
  async initializeResource(types, basepath, resourceName) {
    const resourcePath = path.join(basepath, 'resources', resourceName);
    const configPath = path.join(resourcePath, 'config.json');

    debug(`Reading config.json for resource "${resourceName}" at "${configPath}"`);

    try {
      const configData = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);

      const type = config.type;
      if (!types[type]) {
        throw new Error(`Cannot find type "${type}" for resource "${resourceName}"`);
      }

      const ResourceClass = types[type];
      const resource = new ResourceClass(resourceName, {
        config,
        server: this.server,
        db: this.server.db,
        configPath: resourcePath
      });

      await this.loadResourceExtras(resource);
      debug(`Successfully loaded resource "${resourceName}" of type "${type}"`);

      return resource;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Expected file: ${path.relative(basepath, error.path)}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config.json for resource "${resourceName}": ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Loads additional features or configurations for a resource.
   *
   * @param {Object} resource - The resource instance.
   * @returns {Promise<void>}
   */
  async loadResourceExtras(resource) {
    if (typeof resource.load === 'function') {
      await resource.load();
    }
  }

  /**
   * Adds internal resources such as Files and InternalResources.
   *
   * @param {Object} types - The loaded types.
   * @param {string} basepath - The base path of the project.
   * @param {Array<Object>} loadedResources - The list of loaded resources.
   * @returns {Promise<Array<Object>>} - A promise that resolves with the combined list of resources.
   */
  async addInternalResources(types, basepath, loadedResources) {
    let publicFolder = './public';
    if (this.server.options) {
      publicFolder = this.server.options.public_dir || publicFolder;
      const altPublic = `${publicFolder}-${this.server.options.env}`;

      try {
        await fs.access(altPublic);
        publicFolder = altPublic;
        debug(`Using alternate public folder: ${altPublic}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          debug(`Error accessing alternate public folder "${altPublic}":`, err);
          throw err;
        }
        debug(`Alternate public folder "${altPublic}" not found. Using default public folder: ${publicFolder}`);
      }
    }

    const internals = [
      new Files('', { config: { public: publicFolder }, server: this.server }),
      new InternalResources('__resources', { config: { configPath: basepath }, server: this.server })
    ];

    // Handle self-hosting resources
    try {
      const selfHostingResources = await this.handleSelfHostingResources(types, loadedResources);
      internals.push(...selfHostingResources);
    } catch (error) {
      debug('Error handling self-hosting resources:', error);
      throw error;
    }

    // Load extras for internal resources
    await Promise.all(internals.map(resource => this.loadResourceExtras(resource)));

    return [...loadedResources, ...internals];
  }

  /**
   * Handles self-hosting resources by invoking the selfHost method on types that support it.
   *
   * @param {Object} types - The loaded types.
   * @param {Array<Object>} loadedResources - The list of loaded resources.
   * @returns {Promise<Array<Object>>} - A promise that resolves with the self-hosted resources.
   */
  async handleSelfHostingResources(types, loadedResources) {
    const selfHosting = [];

    for (const type in types) {
      if (typeof types[type].selfHost === 'function') {
        try {
          const resource = await types[type].selfHost({ config: { resources: loadedResources }, server: this.server });
          if (resource) {
            selfHosting.push(resource);
            debug(`Resource "${type}" is self-hosting at "/${resource.name}"`);
          }
        } catch (error) {
          debug(`Error self-hosting resource "${type}":`, error);
          throw error;
        }
      }
    }

    return selfHosting;
  }
}

// Public API compatible with server.js usage
// Signature: loadConfig(basepath, server, cb)
module.exports = {
  loadConfig(basepath, server, cb) {
    const loader = new ConfigLoader(server);
    const p = loader
      .loadConfig(basepath)
      .then((resources) => {
        if (server && server.options && server.options.env !== 'development') {
          server.__resourceCache = resources;
        }
        return resources;
      });

    if (typeof cb === 'function') {
      p.then((resources) => cb(null, resources)).catch((err) => cb(err));
      return;
    }
    return p;
  }
};
