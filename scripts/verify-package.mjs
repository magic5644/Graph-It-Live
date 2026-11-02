import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Checks the files `vsce ls` would package: no source maps, the extension icon,
// and the runtime WASM and Tree-sitter query assets.
// A Node script, not a shell one-liner: npm runs scripts with cmd.exe on Windows.
// Usage: node scripts/verify-package.mjs

const ICON = 'media/Graph-It-Live-Logo-256.png';

/** WASM files the runtime loads from dist/wasm/ (esbuild.js `wasmFiles`). */
export const REQUIRED_WASM = [
  'tree-sitter.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-c_sharp.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-java.wasm',
  'sqljs.wasm',
];

/** dist/ paths of every required WASM file and of every query in resources/queries/. */
export function requiredAssets(root = path.resolve(import.meta.dirname, '..')) {
  const queries = readdirSync(path.join(root, 'resources', 'queries')).filter((file) => file.endsWith('.scm'));
  return [...REQUIRED_WASM.map((file) => `dist/wasm/${file}`), ...queries.map((file) => `dist/queries/${file}`)];
}

/** Returns one error message per failed check of the packaged file list. */
export function packageErrors(listing, assets = requiredAssets()) {
  const files = listing.split(/\r?\n/).map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean);
  const errors = [];
  const maps = files.filter((file) => file.endsWith('.map'));
  if (maps.length > 0) errors.push(`.map files found in package: ${maps.join(', ')}`);
  if (!files.includes(ICON)) errors.push(`extension icon missing from package: ${ICON}`);
  const missing = assets.filter((asset) => !files.includes(asset));
  if (missing.length > 0) errors.push(`runtime assets missing from package: ${missing.join(', ')}`);
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // The local vsce through this Node binary: no PATH lookup, no shell.
  const vsce = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');
  const errors = packageErrors(execFileSync(process.execPath, [vsce, 'ls'], { encoding: 'utf8' }));
  for (const error of errors) console.error(`❌ ERROR: ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log('✅ No .map files in package');
  console.log('✅ Extension icon in package');
  console.log('✅ WASM and query assets in package');
}
