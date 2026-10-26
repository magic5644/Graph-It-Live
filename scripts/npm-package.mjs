import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The npm package ships esbuild bundles of the CLI, MCP server and workers.
// Everything they use is bundled except these externals (see the `external`
// lists of esbuild.js), so the published manifest declares only them; the
// extension's other dependencies are bundled, webview-only or copied WASM.
export const NPM_PACKAGE_NAME = '@magic5644/graph-it-live';
export const NPM_RUNTIME_DEPENDENCIES = ['web-tree-sitter', 'ink', 'react'];
export const NPM_FILES = [
  'dist/graph-it.js',
  'dist/astWorker.js',
  'dist/mcpServer.mjs',
  'dist/mcpWorker.js',
  'dist/indexerWorker.js',
  'dist/wasm/',
  'dist/queries/',
  'README.md',
  'LICENSE',
  'docs/CLI.md',
];

/** Derive the npm package manifest from the extension's package.json, keeping its version ranges. */
export function npmManifest(pkg) {
  const dependencies = {};
  for (const name of NPM_RUNTIME_DEPENDENCIES) {
    const range = pkg.dependencies?.[name];
    if (!range) {
      throw new Error(`package.json dependencies has no "${name}", a runtime dependency of the npm package`);
    }
    dependencies[name] = range;
  }
  return { ...pkg, name: NPM_PACKAGE_NAME, files: NPM_FILES, dependencies };
}

// realpath: a symlinked argv[1] must still run the CLI, or publishing would keep the extension manifest.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    writeFileSync('package.json', `${JSON.stringify(npmManifest(pkg), null, 2)}\n`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
