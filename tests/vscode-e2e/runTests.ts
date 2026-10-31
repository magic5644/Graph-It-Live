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
import { createBranchWatchFixture } from './fixtures/branchWatch.fixture';

// The folder containing the Extension Manifest package.json
const extensionDevelopmentPath = path.resolve(__dirname, '../../');
// Use fixtures as workspace root to allow tests to access all test projects
// Use absolute path from extension root to avoid path resolution issues
const workspaceRoot = path.resolve(extensionDevelopmentPath, 'tests/fixtures');

/**
 * The extension writes its shared index cache to <workspace>/.graph-it/. Under
 * the fixtures it would leak into the next run (a stale index) and the repo.
 */
function removeFixtureIndexCaches(): void {
  for (const entry of fs.readdirSync(workspaceRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === '.graph-it') {
      fs.rmSync(path.join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
}

/** Suite run in a Git repository root, which tests/fixtures is not: Branch Watch needs one (#546). */
const GIT_WORKSPACE_SUITE = 'suite/branchWatchReview.gitWorkspace.js';

/** The Git-workspace pass runs with every suite, or when a scoped run selects Branch Watch. */
function runsGitWorkspaceSuite(env: NodeJS.ProcessEnv = process.env): boolean {
  const selected = env.E2E_SUITE_GLOB?.trim();
  return !selected || /branchWatch/i.test(selected);
}

/**
 * Opens the Branch Watch fixture repository (on `feature`, branched from `main`) with Branch Watch
 * enabled against `main`. Built-in extensions stay enabled: Branch Watch reads the repository through
 * the built-in Git extension. Test-only commands are absent from the VSIX, so this runs from source only.
 */
async function runGitWorkspaceSuite(options: { version: string; cachePath: string; extensionTestsPath: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const workspace = await createBranchWatchFixture();
  try {
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'graph-it-live.branchWatch.enabled': true,
      'graph-it-live.branchWatch.baseRef': 'main',
    }));
    await runTests({
      version: options.version,
      cachePath: options.cachePath,
      extensionDevelopmentPath,
      extensionTestsPath: options.extensionTestsPath,
      extensionTestsEnv: { ...options.env, E2E_SUITE_GLOB: GIT_WORKSPACE_SUITE },
      launchArgs: [workspace],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const useVsix = process.argv.includes('--vsix');
  let temporaryProfileDirectory: string | undefined;

  try {
    removeFixtureIndexCaches();

    // The path to test runner
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

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
      fs.mkdirSync(path.join(userDataDirectory, 'User'), { recursive: true });
      // The VSIX (0.0.1 until CI bumps it) is older than the Marketplace release: without this,
      // VS Code replaces it mid-run and the suites test the published build instead.
      fs.writeFileSync(path.join(userDataDirectory, 'User', 'settings.json'), JSON.stringify({
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
      }));

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
      if (runsGitWorkspaceSuite()) {
        await runGitWorkspaceSuite({ version: vscodeVersion, cachePath: vscodeCachePath, extensionTestsPath, env: extensionTestsEnv });
      }
    }

    console.log('✅ All tests passed!');
  } catch (err) {
    console.error('❌ Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    removeFixtureIndexCaches();
    if (temporaryProfileDirectory) {
      fs.rmSync(temporaryProfileDirectory, { recursive: true, force: true });
    }
  }
}

// Top-level await not supported with module: commonjs in tsconfig
// eslint-disable-next-line unicorn/prefer-top-level-await
main();
