/**
 * Package verification tests
 *
 * scripts/verify-package.mjs checks the `vsce ls` listing: no source maps,
 * the extension icon still packaged although media/ is excluded, and the
 * runtime WASM and query assets.
 */

import { describe, expect, it } from 'vitest';
import { packageErrors, REQUIRED_WASM, requiredAssets } from '../../scripts/verify-package.mjs';

const ICON = 'media/Graph-It-Live-Logo-256.png';
const ASSETS = ['dist/wasm/tree-sitter-tsx.wasm', 'dist/queries/tsx.scm'];

describe('packageErrors', () => {
  it('accepts a listing with the icon, the assets and no source maps', () => {
    expect(packageErrors(['package.json', 'dist/extension.js', ICON, ...ASSETS, ''].join('\n'), ASSETS)).toEqual([]);
  });

  it('accepts Windows separators and line endings', () => {
    expect(packageErrors(['dist\\extension.js', String.raw`media\Graph-It-Live-Logo-256.png`, String.raw`dist\wasm\tree-sitter-tsx.wasm`, String.raw`dist\queries\tsx.scm`].join('\r\n'), ASSETS)).toEqual([]);
  });

  it('reports a missing icon, every source map and every missing asset', () => {
    expect(packageErrors(['dist/extension.js', 'dist/extension.js.map', 'dist/mcpServer.mjs.map', 'dist/queries/tsx.scm'].join('\n'), ASSETS)).toEqual([
      '.map files found in package: dist/extension.js.map, dist/mcpServer.mjs.map',
      `extension icon missing from package: ${ICON}`,
      'runtime assets missing from package: dist/wasm/tree-sitter-tsx.wasm',
    ]);
  });
});

describe('requiredAssets', () => {
  it('lists every grammar, the tsx one included, and every query of resources/queries', () => {
    const assets = requiredAssets();
    expect(REQUIRED_WASM).toContain('tree-sitter-tsx.wasm');
    expect(assets).toEqual(expect.arrayContaining([
      'dist/wasm/tree-sitter-tsx.wasm',
      'dist/wasm/tree-sitter-typescript.wasm',
      'dist/wasm/sqljs.wasm',
      'dist/queries/typescript.scm',
      'dist/queries/tsx.scm',
      'dist/queries/python.scm',
    ]));
  });
});
