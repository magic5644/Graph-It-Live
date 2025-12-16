/**
 * VSCode Extension E2E Tests
 * 
 * These tests run the extension in a real VSCode instance.
 * They verify:
 * - Extension activation
 * - Command execution
 * - Webview creation
 * - File analysis functionality
 */

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

try {
  // The folder containing the Extension Manifest package.json
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');

  // The path to test runner
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  // Download VS Code, unzip it and run the integration test
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // Use a test workspace
    launchArgs: [
      path.resolve(__dirname, '../fixtures/sample-project'),
      '--disable-extensions', // Disable other extensions for clean testing
    ],
  });
} catch (err) {
  console.error('Failed to run tests:', err);
  process.exit(1);
}
