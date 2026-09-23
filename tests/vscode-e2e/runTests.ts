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
import * as os from 'node:os';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';

async function main() {
  const useVsix = process.argv.includes('--vsix');
  let temporaryProfileDirectory: string | undefined;

  try {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to test runner
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Use fixtures as workspace root to allow tests to access all test projects
    // Use absolute path from extension root to avoid path resolution issues
    const workspaceRoot = path.resolve(extensionDevelopmentPath, 'tests/fixtures');
    const vscodeVersion = process.env.VSCODE_TEST_VERSION ?? 'stable';
    const vscodeCachePath = path.resolve(extensionDevelopmentPath, '.vscode-test');
    const reportFileFromEnv = process.env.E2E_MOCHA_REPORT_FILE;
    let resolvedReportFile: string | undefined;

    if (reportFileFromEnv) {
      if (path.isAbsolute(reportFileFromEnv)) {
        resolvedReportFile = reportFileFromEnv;
      } else {
        resolvedReportFile = path.resolve(extensionDevelopmentPath, reportFileFromEnv);
      }
    }

    if (resolvedReportFile) {
      fs.mkdirSync(path.dirname(resolvedReportFile), { recursive: true });
    }

    const extensionTestsEnv = {
      ...process.env,
      ...(resolvedReportFile ? { E2E_MOCHA_REPORT_FILE: resolvedReportFile } : {}),
    };

    const launchArgs = [workspaceRoot, '--disable-extensions'];

    if (useVsix) {
      // Test from packaged .vsix file (production mode)
      const vsixFiles = fs.readdirSync(extensionDevelopmentPath)
        .filter(f => f.endsWith('.vsix'))
        .sort((a, b) => a.localeCompare(b))
        .reverse(); // Get latest

      if (vsixFiles.length === 0) {
        throw new Error('No .vsix file found. Run `npm run package` first.');
      }

      const vsixPath = path.resolve(extensionDevelopmentPath, vsixFiles[0]);
      console.log(`📦 Testing packaged extension: ${vsixFiles[0]}`);

      temporaryProfileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'g-vsix-'));
      const extensionsDirectory = path.join(temporaryProfileDirectory, 'extensions');
      const userDataDirectory = path.join(temporaryProfileDirectory, 'user-data');
      fs.mkdirSync(extensionsDirectory, { recursive: true });
      fs.mkdirSync(userDataDirectory, { recursive: true });

      const isolatedProfileArgs = [
        `--extensions-dir=${extensionsDirectory}`,
        `--user-data-dir=${userDataDirectory}`,
      ];

      await runVSCodeCommand([
        ...isolatedProfileArgs,
        `--install-extension=${vsixPath}`,
        '--force',
      ], { version: vscodeVersion, cachePath: vscodeCachePath });

      await runTests({
        version: vscodeVersion,
        cachePath: vscodeCachePath,
        extensionDevelopmentPath: path.resolve(__dirname, 'test-host'),
        extensionTestsPath,
        extensionTestsEnv: {
          ...extensionTestsEnv,
          E2E_EXPECTED_VSIX_EXTENSION_DIR: extensionsDirectory,
        },
        launchArgs: [
          workspaceRoot,
          ...isolatedProfileArgs,
        ],
      });
    } else {
      // Test from source (development mode)
      console.log('🔧 Testing extension from source (development mode)');
      
      await runTests({
        version: vscodeVersion,
        cachePath: vscodeCachePath,
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv,
        launchArgs,
      });
    }

    console.log('✅ All tests passed!');
  } catch (err) {
    console.error('❌ Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    if (temporaryProfileDirectory) {
      fs.rmSync(temporaryProfileDirectory, { recursive: true, force: true });
    }
  }
}

// Top-level await not supported with module: commonjs in tsconfig
// eslint-disable-next-line unicorn/prefer-top-level-await
main();
