const fs = require('fs').promises;
const path = require('path');
const debug = require('debug')('type-loader');
const _ = require('lodash');

/**
 * Load custom resource types from the specified basepath.
 *
 * @param {String} [basepath='.'] - The base directory path to load types from.
 * @param {Function} fn - Callback function with signature (defaults, types).
 */
async function loadTypes(basepath = '.', fn) {
  // Support old signature loadTypes(fn)
  if (typeof basepath === 'function' && !fn) {
    fn = basepath;
    basepath = '.';
  }
  const types = {};
  const defaults = {};

  try {
    const resourcesDir = path.join(__dirname, 'resources');
    await loadDefaultResources(resourcesDir, defaults);

    const packageJsonPath = path.join(basepath, 'package.json');
    let dependencies = [];

    // Check if package.json exists
    try {
      await fs.access(packageJsonPath);
      const packageJsonData = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonData);

      if (packageJson) {
        dependencies = packageJson.dpdInclude && Array.isArray(packageJson.dpdInclude)
          ? packageJson.dpdInclude
          : [
              ...Object.keys(packageJson.dependencies || {}),
              ...Object.keys(packageJson.devDependencies || {}),
            ];

        const dpdIgnore = packageJson.dpdIgnore || [];

        debug('Loading these dependencies from package.json:', dependencies);

        // Filter out ignored dependencies
        const filteredDependencies = dependencies.filter(dep => !dpdIgnore.includes(dep));

        // Load custom resources
        await Promise.all(filteredDependencies.map(dep => loadCustomResource(basepath, dep, types)));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error reading package.json:', err.message);
        console.error(err.stack || err);
        if (process.send) process.send({ moduleError: err || true });
        process.exit(1);
      } else {
        debug('package.json not found. Loading local project resources.');
      }
    }

    // If package.json doesn't exist or no dependencies to load, load local node_modules
    if (!(await exists(packageJsonPath))) {
      const nodeModulesPath = path.join(basepath, 'node_modules');
      try {
        const modules = await fs.readdir(nodeModulesPath);
        await Promise.all(
          modules
            .filter(file => isValidModuleFile(file))
            .map(file => loadCustomResource(basepath, file, types))
        );
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error('Error reading node_modules:', err.message);
          console.error(err.stack || err);
          if (process.send) process.send({ moduleError: err || true });
          process.exit(1);
        }
      }
    }

    // Return or callback with loaded resources
    if (typeof fn === 'function') {
      fn(defaults, types);
      return;
    } else {
      return { defaults, types };
    }
  } catch (err) {
    console.error('Unexpected error in loadTypes:', err.message);
    console.error(err.stack || err);
    if (process.send) process.send({ moduleError: err || true });
    process.exit(1);
  }
}

/**
 * Check if a file or directory exists.
 *
 * @param {String} filepath - The path to check.
 * @returns {Promise<Boolean>} - True if exists, else false.
 */
async function exists(filepath) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load default resources from the specified directory.
 *
 * @param {String} resourcesDir - The directory containing default resources.
 * @param {Object} defaults - The object to populate with default resources.
 */
async function loadDefaultResources(resourcesDir, defaults) {
  try {
    const files = await fs.readdir(resourcesDir);
    await Promise.all(
      files
        .filter(file => isValidModuleFile(file))
        .map(async file => {
          try {
            const resourcePath = path.join(resourcesDir, file);
            const customResource = require(resourcePath);
            defaults[customResource.name] = customResource;
            debug('Loaded default resource:', customResource.name);
          } catch (err) {
            console.error(`Error loading default resource "${file}":`, err.message);
            console.error(err.stack || err);
            if (process.send) process.send({ moduleError: err || true });
            process.exit(1);
          }
        })
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading default resources:', err.message);
      console.error(err.stack || err);
      if (process.send) process.send({ moduleError: err || true });
      process.exit(1);
    }
    debug('Default resources directory not found. Skipping default resources.');
  }
}

/**
 * Determine if a file is a valid module file (.js or no extension).
 *
 * @param {String} file - The filename to check.
 * @returns {Boolean} - True if valid, else false.
 */
function isValidModuleFile(file) {
  return file.endsWith('.js') || !path.extname(file);
}

/**
 * Load a custom resource module.
 *
 * @param {String} basepath - The base directory path.
 * @param {String} file - The module filename.
 * @param {Object} types - The object to populate with custom resources.
 */
async function loadCustomResource(basepath, file, types) {
  try {
    const modulePath = path.join(basepath, 'node_modules', file);
    const resolvedPath = require.resolve(modulePath);
    const customResource = require(resolvedPath);

    if (customResource && customResource.prototype && customResource.prototype.__resource__) {
      types[customResource.name] = customResource;
      debug('Loaded custom resource:', customResource.name);
    } else {
      debug(`Module "${file}" is not a valid custom resource.`);
    }
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.error(`Error loading module "node_modules/${file}":`, err.message);
      console.error(err.stack || err);
      if (process.send) process.send({ moduleError: err || true });
      process.exit(1);
    } else {
      debug(`Module "${file}" not found. Skipping.`);
    }
  }
}

module.exports = loadTypes;
