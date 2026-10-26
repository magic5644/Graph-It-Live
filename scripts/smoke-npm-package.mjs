// npm package smoke check: pack the npm manifest with the built dist/, install
// the tarball with --ignore-scripts in an empty folder, then run the CLI, the
// MCP server and its worker from that install. A runtime import missing from
// NPM_RUNTIME_DEPENDENCIES fails here. Run `npm run build:cli` first.
// Usage: node scripts/smoke-npm-package.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeSession, startMcpSession } from './mcpSession.ts';
import { NPM_FILES, NPM_PACKAGE_NAME, npmManifest } from './npm-package.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Python files go through web-tree-sitter and its WASM grammar.
const fixture = path.join(root, 'tests', 'fixtures', 'python-project');
const isWindows = process.platform === 'win32';

// npm and the graph-it bin are .cmd shims on Windows, which only a shell runs.
// A quoted bare `"npm"` makes npm.cmd resolve %~dp0 to the cwd: quote paths only.
const quote = (part) => (path.isAbsolute(part) || part.includes(' ') ? `"${part}"` : part);

function run(command, args, cwd) {
  const result = isWindows
    ? spawnSync([command, ...args].map(quote).join(' '), { cwd, encoding: 'utf8', shell: true, timeout: 300_000 })
    : spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}: ${(result.stderr || result.error?.message)?.slice(-2000)}`);
  }
  return result.stdout;
}

function pass(label) {
  console.log(`✔ ${label}`);
}

function packAndInstall(work, pkg) {
  const stage = path.join(work, 'stage');
  const install = path.join(work, 'install');
  for (const file of NPM_FILES) {
    cpSync(path.join(root, file), path.join(stage, file), { recursive: true });
  }
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(npmManifest(pkg), null, 2)}\n`);
  // npm <= 11 prints an array of packages, npm 12 an object keyed by package name.
  const [packed] = Object.values(JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts'], stage)));
  mkdirSync(install);
  renameSync(path.join(stage, packed.filename), path.join(install, 'package.tgz'));
  // --omit=peer: ink's react peer must come from the declared dependencies, not npm's peer install.
  run('npm', ['install', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund', './package.tgz'], install);
  pass(`packed and installed ${packed.filename}`);
  return install;
}

async function checkMcpServer(entry, workspace, version) {
  const { child, request, callTool, initialize } = await startMcpSession(entry, workspace, workspace);
  try {
    assert.equal(initialize.result?.serverInfo?.version, version, 'serve serverInfo.version');
    pass(`serve initialize, serverInfo.version = ${version}`);
    const { tools } = (await request('tools/list', {})).result;
    assert.ok(tools.some((tool) => tool.name === 'graphitlive_analyze_dependencies'), 'tools/list has graphitlive_analyze_dependencies');
    pass(`serve tools/list (${tools.length} tools)`);
    const status = await callTool('graphitlive_get_index_status', {});
    assert.ok(!status.isError, `get_index_status: ${status.content[0]?.text}`);
    const deps = await callTool('graphitlive_analyze_dependencies', { filePath: path.join(workspace, 'main.py') });
    assert.ok(!deps.isError && deps.content[0]?.text.includes('helpers'), `analyze_dependencies: ${deps.content[0]?.text}`);
    pass('serve tools/call get_index_status, analyze_dependencies main.py in the MCP worker');
  } finally {
    assert.equal(await closeSession(child), 0, 'serve exit code');
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Same mapping as esbuild.js CLI_VERSION.
const version = pkg.version === '0.0.1' ? '0.0.0-dev' : pkg.version;
const work = mkdtempSync(path.join(tmpdir(), 'graph-it-npm-smoke-'));
try {
  const install = packAndInstall(work, pkg);
  const workspace = path.join(work, 'workspace');
  cpSync(fixture, workspace, { recursive: true });
  const bin = path.join(install, 'node_modules', '.bin', isWindows ? 'graph-it.cmd' : 'graph-it');
  const entry = path.join(install, 'node_modules', ...NPM_PACKAGE_NAME.split('/'), 'dist', 'graph-it.js');

  assert.equal(run(bin, ['--version'], workspace).trim(), `graph-it-live v${version}`);
  pass('graph-it --version');
  assert.match(run(bin, ['summary'], workspace), /indexedFiles: [1-9]/);
  pass('graph-it summary');
  await checkMcpServer(entry, workspace, version);
  // The REPL needs a TTY: load its externals from the installed package instead.
  const requireFromCli = createRequire(entry);
  await import(pathToFileURL(requireFromCli.resolve('ink')).href);
  requireFromCli('react');
  pass('REPL dependencies ink and react load');
  console.log('npm package smoke check passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
