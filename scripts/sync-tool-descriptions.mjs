// Rewrites contributes.languageModelTools[].modelDescription in package.json
// from src/mcp/toolDescriptions.ts. Run with --check to fail on drift instead.
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const packagePath = 'package.json';
const lmPrefix = 'graph-it-live_';

const bundle = await build({
  entryPoints: ['src/mcp/toolDescriptions.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { lmToolDescription } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const source = await readFile(packagePath, 'utf8');
const manifest = JSON.parse(source);
for (const tool of manifest.contributes.languageModelTools) {
  tool.modelDescription = lmToolDescription(tool.name.slice(lmPrefix.length));
}
const updated = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (updated !== source) {
    console.error('package.json modelDescription is out of date. Run: npm run sync:tool-descriptions');
    process.exit(1);
  }
} else if (updated !== source) {
  await writeFile(packagePath, updated);
  console.log('Updated package.json modelDescription fields.');
}
