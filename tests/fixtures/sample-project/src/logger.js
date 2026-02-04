/**
 * Simple logging module for testing JavaScript analysis
 */

/**
 * Log an info message
 * @param {string} message - Message to log
 */
function log(message) {
  console.log(`[INFO] ${message}`);
}

/**
 * Log a warning message
 * @param {string} message - Warning message
 */
function warn(message) {
  console.warn(`[WARN] ${message}`);
}

/**
 * Log an error message
 * @param {string} message - Error message
 */
function error(message) {
  console.error(`[ERROR] ${message}`);
}

/**
 * Helper function that calls log
 * @param {string} text - Text to debug
 */
function debug(text) {
  log(`Debug: ${text}`);
}

/**
 * Helper function that calls warn and error
 * @param {string} message - Issue message
 */
function reportIssue(message) {
  warn(`Issue detected: ${message}`);
  error(`Logging issue for tracking`);
}

module.exports = {
  log,
  warn,
  error,
  debug,
  reportIssue
};
