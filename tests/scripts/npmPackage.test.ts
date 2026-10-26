/**
 * npm package manifest tests
 *
 * scripts/npm-package.mjs derives the published npm manifest from the
 * extension's package.json: scoped name, the files of the CLI bundles, and
 * only the dependencies the bundles import at runtime, with their ranges.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NPM_FILES, NPM_PACKAGE_NAME, NPM_RUNTIME_DEPENDENCIES, npmManifest } from '../../scripts/npm-package.mjs';

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'npm-package.mjs');
const extensionPkg = {
  name: 'graph-it-live',
  version: '1.2.3',
  bin: { 'graph-it': './dist/graph-it.js' },
  files: ['dist/'],
  dependencies: { 'web-tree-sitter': '^0.26.13', ink: '^7.1.1', react: '^19.3.1', 'ts-morph': '^27.0.2', cytoscape: '^3.34.4' },
};

describe('npmManifest', () => {
  it('keeps only the runtime dependencies with the package.json ranges', () => {
    const manifest = npmManifest(extensionPkg);

    expect(manifest.dependencies).toEqual({ 'web-tree-sitter': '^0.26.13', ink: '^7.1.1', react: '^19.3.1' });
    expect(manifest.name).toBe(NPM_PACKAGE_NAME);
    expect(manifest.files).toEqual(NPM_FILES);
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.bin).toEqual({ 'graph-it': './dist/graph-it.js' });
    expect(extensionPkg.dependencies).toHaveProperty('ts-morph');
  });

  it('is idempotent on an npm manifest', () => {
    const manifest = npmManifest(extensionPkg);

    expect(npmManifest(manifest)).toEqual(manifest);
  });

  it('fails when package.json lacks a runtime dependency', () => {
    const dependencies: Record<string, string> = { ...extensionPkg.dependencies };
    delete dependencies.ink;

    expect(() => npmManifest({ ...extensionPkg, dependencies })).toThrow('no "ink"');
    expect(() => npmManifest({ name: 'x' })).toThrow('no "web-tree-sitter"');
  });

  it('finds every runtime dependency in the repository package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    expect(Object.keys(npmManifest(pkg).dependencies)).toEqual(NPM_RUNTIME_DEPENDENCIES);
  });
});

describe('npm-package.mjs CLI', () => {
  const runScript = (file: string) => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });

  it('rewrites the given package.json in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-package-'));
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify(extensionPkg));
    try {
      expect(runScript(file).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(npmManifest(extensionPkg));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites package.json when run through a symlinked scripts folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-package-'));
    const file = path.join(dir, 'package.json');
    const link = path.join(dir, 'scripts-link');
    fs.writeFileSync(file, JSON.stringify(extensionPkg));
    // A junction needs no admin rights on Windows; other platforms ignore the type.
    fs.symlinkSync(path.dirname(script), link, 'junction');
    try {
      const result = spawnSync(process.execPath, [path.join(link, 'npm-package.mjs'), file], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).name).toBe(NPM_PACKAGE_NAME);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 without writing when a runtime dependency is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-package-'));
    const file = path.join(dir, 'package.json');
    const content = JSON.stringify({ name: 'x', dependencies: {} });
    fs.writeFileSync(file, content);
    try {
      const result = runScript(file);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR: package.json dependencies has no "web-tree-sitter"');
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
