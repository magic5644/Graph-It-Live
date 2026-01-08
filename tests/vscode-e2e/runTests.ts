/**
 * VSCode Extension E2E Tests
 * 
 * These tests run the extension in a real VSCode instance.
 * They verify:
 * - Extension activation
 * - Command execution
 * - Webview creation
 * - File analysis functionality
 * 
 * Usage:
 * - `npm run test:vscode` - Test from source (development mode)
 * - `npm run test:vscode:vsix` - Test from packaged .vsix (production mode)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  const useVsix = process.argv.includes('--vsix');

  try {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to test runner
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Use fixtures as workspace root to allow tests to access all test projects
    // Use absolute path from extension root to avoid path resolution issues
    const workspaceRoot = path.resolve(extensionDevelopmentPath, 'tests/fixtures');
    const launchArgs = [
      workspaceRoot,
      '--disable-extensions', // Disable other extensions for clean testing
    ];

    if (useVsix) {
      // Test from packaged .vsix file (production mode)
      const vsixFiles = fs.readdirSync(extensionDevelopmentPath)
        .filter(f => f.endsWith('.vsix'))
        .sort()
        .reverse(); // Get latest

      if (vsixFiles.length === 0) {
        throw new Error('No .vsix file found. Run `npm run package` first.');
      }

      const vsixPath = path.resolve(extensionDevelopmentPath, vsixFiles[0]);
      console.log(`📦 Testing packaged extension: ${vsixFiles[0]}`);

      // When testing .vsix, we still need extensionDevelopmentPath for the test runner
      // but the extension is loaded from the installed .vsix
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
          ...launchArgs,
          `--install-extension=${vsixPath}`,
        ],
      });
    } else {
      // Test from source (development mode)
      console.log('🔧 Testing extension from source (development mode)');
      
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs,
      });
    }

    console.log('✅ All tests passed!');
  } catch (err) {
    console.error('❌ Failed to run tests:', err);
    process.exit(1);
  }
}

// Top-level await not supported with module: commonjs in tsconfig
// eslint-disable-next-line unicorn/prefer-top-level-await
main();