import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { PythonParser } from '@/analyzer/languages/PythonParser';
import { normalizePath } from '@/shared/path';

describe('PythonParser', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/python-project');
  let parser: PythonParser;

  beforeEach(() => {
    parser = new PythonParser(fixturesDir);
  });

  describe('parseImports', () => {
    it('should parse absolute imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module).sort();
      expect(modules).toContain('utils.helpers');
    });

    it('should parse from...import statements', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module);
      expect(modules).toContain('utils.helpers');
    });

    it('should parse relative imports with dot', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const deps = await parser.parseImports(relFile);

      const modules = deps.map(d => d.module).sort();
      expect(modules).toContain('.');
      expect(modules).toContain('.utils');
      expect(modules).toContain('..utils.helpers');
    });

    it('should parse import aliases', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const deps = await parser.parseImports(relFile);

      // Should capture the module being imported (before 'as')
      const modules = deps.map(d => d.module);
      expect(modules).toContain('.utils');
    });

    it('should not duplicate imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module);
      const uniqueModules = [...new Set(modules)];
      expect(modules.length).toBe(uniqueModules.length);
    });

    it('should include line numbers', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      expect(deps.every(d => d.line > 0)).toBe(true);
    });
  });

  describe('resolvePath', () => {
    it('should resolve absolute imports to __init__.py', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', '__init__.py'))
      );
    });

    it('should resolve absolute imports to module file', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils.helpers');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', 'helpers.py'))
      );
    });

    it('should resolve single dot relative import', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const resolved = await parser.resolvePath(relFile, '.');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, '__init__.py'))
      );
    });

    it('should resolve relative import with module name', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const resolved = await parser.resolvePath(relFile, '.utils');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', '__init__.py'))
      );
    });

    it('should resolve double dot relative import', async () => {
      const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
      const resolved = await parser.resolvePath(helpersFile, '..');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, '__init__.py'))
      );
    });

    it('should return null for unresolvable imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'nonexistent.module');

      expect(resolved).toBeNull();
    });

    it('should normalize paths before returning', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils');

      expect(resolved).toBeTruthy();
      // Should use forward slashes and lowercase drive letters
      expect(resolved).not.toContain('\\');
      if (process.platform === 'win32') {
        expect(resolved![0]).toBe(resolved![0].toLowerCase());
      }
    });
  });

  describe('cross-platform compatibility', () => {
    it('should handle Windows paths with normalizePath', async () => {
      // Use String.raw for Windows-style paths
      const windowsStylePath = String.raw`C:\Users\test\project\main.py`;
      const normalized = normalizePath(windowsStylePath);

      // Should convert to forward slashes and lowercase drive letter
      expect(normalized).toContain('/');
      expect(normalized).not.toContain('\\');
      if (normalized.includes(':')) {
        expect(normalized[0]).toBe('c');
      }
    });

    it('should resolve paths consistently across platforms', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved1 = await parser.resolvePath(mainFile, 'utils');
      const resolved2 = await parser.resolvePath(mainFile, 'utils');

      expect(normalizePath(resolved1!)).toBe(normalizePath(resolved2!));
    });
  });
});
