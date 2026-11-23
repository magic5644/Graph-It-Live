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

/** Suites run in a window without a folder, and in a two-folder workspace (#770). */
const NO_FOLDER_SUITE = 'suite/noFolder.launch.js';
const MULTI_ROOT_SUITE = 'suite/multiRoot.launch.js';
/** Suite run on a generated workspace past the 60-unit diagram cap: in the shared fixtures it would change every count (#795). */
const UNIT_CAP_SUITE = 'suite/unitCap.launch.js';

/** A separate-launch pass runs with every suite, or when a scoped run names it. */
function runsLaunchSuite(name: RegExp, env: NodeJS.ProcessEnv = process.env): boolean {
  const selected = env.E2E_SUITE_GLOB?.trim();
  return !selected || name.test(selected);
}

/**
 * How a window loads the extension: from source (`--disable-extensions`), or the installed VSIX (its isolated
 * profile, with the test host as development path) so CI runs the separate-launch suites too (#823).
 */
type LaunchOptions = {
  version: string;
  cachePath: string;
  extensionTestsPath: string;
  env: NodeJS.ProcessEnv;
  developmentPath: string;
  profileArgs: string[];
};

/** Runs one suite in its own window; `target` is a folder or `.code-workspace` file, or nothing for an empty window. */
async function runSuiteInWindow(options: LaunchOptions, suite: string, target?: string): Promise<void> {
  await runTests({
    version: options.version,
    cachePath: options.cachePath,
    extensionDevelopmentPath: options.developmentPath,
    extensionTestsPath: options.extensionTestsPath,
    extensionTestsEnv: { ...options.env, E2E_SUITE_GLOB: suite },
    launchArgs: [...(target ? [target] : []), ...options.profileArgs, ...RENDERING_ARGS],
  });
}

/** A glob naming only a separate-launch suite skips the fixtures window, where that suite cannot pass. */
const runsFixturesWindow = (env: NodeJS.ProcessEnv = process.env) => !env.E2E_SUITE_GLOB?.trim().endsWith('.launch.js');

/** The separate-launch suites the run selects, each in its own window. */
async function runLaunchSuites(launch: LaunchOptions): Promise<void> {
  if (runsLaunchSuite(/noFolder/i)) await runSuiteInWindow(launch, NO_FOLDER_SUITE);
  if (runsLaunchSuite(/multiRoot/i)) await runMultiRootSuite(launch);
  if (runsLaunchSuite(/unitCap/i)) await runUnitCapSuite(launch);
}

/** Two folders; the setting selects the second, whose `lib.ts` is called from its `caller.ts`. */
async function runMultiRootSuite(options: LaunchOptions): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g-multiroot-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'alpha.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(second, 'lib.ts'), 'export function beta(): number {\n  return 2;\n}\n');
    fs.writeFileSync(path.join(second, 'caller.ts'), "import { beta } from './lib';\n\nexport function run(): number {\n  return beta();\n}\n");
    // #823: a file of the folder not analyzed, whose entry's calls all stay in the file.
    fs.mkdirSync(path.join(first, 'maths'));
    fs.writeFileSync(path.join(first, 'maths', 'index.ts'), [
      "function toNumber(value: unknown): number { return typeof value === 'number' ? value : Number(value); }",
      'export function mathFix(value: unknown, dec = 2): number { return Number(toNumber(value).toFixed(dec)); }',
      'export function format(value: unknown): string { return String(mathFix(toNumber(value))); }',
      '',
    ].join('\n'));
    const workspaceFile = path.join(root, 'multi.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({
      folders: [{ path: first }, { path: second }],
      // No pre-index: Show Call Graph alone must index the selected folder.
      settings: { 'graph-it-live.workspaceFolder': second, 'graph-it-live.preIndexCallGraph': false },
    }));
    await runSuiteInWindow(options, MULTI_ROOT_SUITE, workspaceFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 61 packages, each importing the next and the last the first: one cycle of 61 units, past the cap of 60. */
async function runUnitCapSuite(options: LaunchOptions): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g-unitcap-'));
  try {
    const name = (index: number) => `pkg-${String(index % 61).padStart(2, '0')}`;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'unit-cap', private: true, workspaces: ['packages/*'] }));
    for (let index = 0; index < 61; index += 1) {
      const folder = path.join(root, 'packages', name(index));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: name(index) }));
      fs.writeFileSync(path.join(folder, 'index.ts'), `import { value as next } from '../${name(index + 1)}/index';\nexport const value = 1;\nexport function read(): number {\n  return next;\n}\n`);
    }
    await runSuiteInWindow(options, UNIT_CAP_SUITE, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The Git-workspace pass runs with every suite, or when a scoped run selects Branch Watch. */
function runsGitWorkspaceSuite(env: NodeJS.ProcessEnv = process.env): boolean {
  return runsLaunchSuite(/branchWatch/i, env);
}

/**
 * Opens the Branch Watch fixture repository (on `feature`, branched from `main`) with Branch Watch
 * enabled against `main`. Built-in extensions stay enabled: Branch Watch reads the repository through
 * the built-in Git extension. Test-only commands are absent from the VSIX, so this runs from source only.
 */
async function runGitWorkspaceSuite(options: LaunchOptions): Promise<void> {
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
      launchArgs: [workspace, ...RENDERING_ARGS],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Keep the webviews rendering when the test window is hidden behind other windows: Chromium pauses animation
 * frames and resize observers there (macOS occlusion), so render reports never arrive on a local run.
 */
const RENDERING_ARGS = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];

/** Optional loopback DevTools port, used for local E2E screenshots. */
function debuggingArgs(port = process.env.E2E_CDP_PORT): string[] {
  if (!port) return [];
  if (!/^\d+$/.test(port)) throw new Error('E2E_CDP_PORT must be a port number');
  return [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
}

/** The fixtures window, then each separate-launch suite the run selects. */
async function runFromSource(launch: LaunchOptions, launchArgs: string[]): Promise<void> {
  if (runsFixturesWindow(launch.env)) {
    await runTests({
      version: launch.version,
      cachePath: launch.cachePath,
      extensionDevelopmentPath,
      extensionTestsPath: launch.extensionTestsPath,
      extensionTestsEnv: launch.env,
      launchArgs,
    });
  }
  if (runsGitWorkspaceSuite()) await runGitWorkspaceSuite(launch);
  await runLaunchSuites(launch);
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

    const launchArgs = [workspaceRoot, '--disable-extensions', ...RENDERING_ARGS, ...debuggingArgs()];

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

      const vsixLaunch: LaunchOptions = {
        version: vscodeVersion,
        cachePath: vscodeCachePath,
        extensionTestsPath,
        env: { ...extensionTestsEnv, E2E_EXPECTED_VSIX_EXTENSION_DIR: extensionsDirectory },
        developmentPath: path.resolve(__dirname, 'test-host'),
        profileArgs: isolatedProfileArgs,
      };
      if (runsFixturesWindow()) await runSuiteInWindow(vsixLaunch, process.env.E2E_SUITE_GLOB ?? '', workspaceRoot);
      await runLaunchSuites(vsixLaunch);
    } else {
      // Test from source (development mode)
      console.log('🔧 Testing extension from source (development mode)');
      
      await runFromSource({
        version: vscodeVersion, cachePath: vscodeCachePath, extensionTestsPath, env: extensionTestsEnv,
        developmentPath: extensionDevelopmentPath, profileArgs: ['--disable-extensions'],
      }, launchArgs);
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
