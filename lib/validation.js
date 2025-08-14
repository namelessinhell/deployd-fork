/**
 * Simple validation utilities for Deployd
 */

/**
 * Check if a value exists (not null, undefined, or empty string)
 * @param {*} val - The value to check
 * @returns {boolean} - True if the value exists
 */
function exists(val) {
  return val !== null && val !== undefined && val !== '';
}

/**
 * Check if a value is of a specific type
 * @param {*} val - The value to check
 * @param {string} type - The expected type
 * @returns {boolean} - True if the value is of the expected type
 */
function isType(val, type) {
  switch (type) {
    case 'string':
      return typeof val === 'string';
    case 'number':
      return typeof val === 'number' && !isNaN(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'date':
      return val instanceof Date && !isNaN(val.getTime());
    case 'array':
      return Array.isArray(val);
    case 'object':
      return typeof val === 'object' && val !== null && !Array.isArray(val);
    default:
      return true; // Unknown types are considered valid
  }
}

module.exports = {
  exists,
  isType
};
