/**
 * Package verification tests
 *
 * scripts/verify-package.mjs checks the `vsce ls` listing: no source maps,
 * and the extension icon still packaged although media/ is excluded.
 */

import { describe, expect, it } from 'vitest';
import { packageErrors } from '../../scripts/verify-package.mjs';

const ICON = 'media/Graph-It-Live-Logo-256.png';

describe('packageErrors', () => {
  it('accepts a listing with the icon and no source maps', () => {
    expect(packageErrors(['package.json', 'dist/extension.js', ICON, ''].join('\n'))).toEqual([]);
  });

  it('accepts Windows separators and line endings', () => {
    expect(packageErrors(['dist\\extension.js', String.raw`media\Graph-It-Live-Logo-256.png`].join('\r\n'))).toEqual([]);
  });

  it('reports a missing icon and every source map', () => {
    expect(packageErrors(['dist/extension.js', 'dist/extension.js.map', 'dist/mcpServer.mjs.map'].join('\n'))).toEqual([
      '.map files found in package: dist/extension.js.map, dist/mcpServer.mjs.map',
      `extension icon missing from package: ${ICON}`,
    ]);
  });
});
