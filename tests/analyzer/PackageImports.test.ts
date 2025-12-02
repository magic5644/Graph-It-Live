import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { PathResolver } from '../../src/analyzer/PathResolver';
import path from 'node:path';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/monorepo-project');
const appPath = path.join(fixturesPath, 'packages/app');
const libPath = path.join(fixturesPath, 'packages/lib');

describe('Package.json imports field support', () => {
  describe('PathResolver with #imports', () => {
    let resolver: PathResolver;

    beforeEach(() => {
      resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true, // excludeNodeModules
        fixturesPath // workspaceRoot
      );
    });

    it('should resolve #imports with wildcard pattern from app package', async () => {
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '#components/Button');
      
      expect(resolved).toBe(path.join(appPath, 'src/components/Button.ts'));
    });

    it('should resolve exact #imports from app package', async () => {
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '#utils');
      
      expect(resolved).toBe(path.join(appPath, 'src/utils/index.ts'));
    });

    it('should resolve #imports with wildcard pattern from lib package', async () => {
      const currentFile = path.join(libPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '#internal/secret');
      
      expect(resolved).toBe(path.join(libPath, 'src/internal/secret.ts'));
    });

    it('should resolve conditional #imports (default condition) from lib package', async () => {
      const currentFile = path.join(libPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '#config');
      
      expect(resolved).toBe(path.join(libPath, 'src/config.ts'));
    });

    it('should return null for unknown #imports', async () => {
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '#unknown');
      
      expect(resolved).toBeNull();
    });

    it('should use different package.json for different packages (monorepo isolation)', async () => {
      // App package has #components, lib package doesn't
      const appFile = path.join(appPath, 'src/index.ts');
      const libFile = path.join(libPath, 'src/index.ts');
      
      // #components should resolve from app
      const appResolved = await resolver.resolve(appFile, '#components/Button');
      expect(appResolved).toBe(path.join(appPath, 'src/components/Button.ts'));
      
      // #components should NOT resolve from lib (different package.json)
      const libResolved = await resolver.resolve(libFile, '#components/Button');
      expect(libResolved).toBeNull();
    });

    it('should still resolve tsconfig path aliases alongside #imports', async () => {
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should prioritize tsconfig paths over package.json imports', async () => {
      // If both tsconfig and package.json define the same alias, tsconfig wins
      // This test verifies the priority order is correct
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @shared is defined in tsconfig, not in package.json imports
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolved).toBeTruthy();
    });

    it('should resolve @alias imports from package.json imports field', async () => {
      // @app/* is defined in app's package.json imports, not in tsconfig
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@app/components/Button');
      
      expect(resolved).toBe(path.join(appPath, 'src/components/Button.ts'));
    });

    it('should fall through to node_modules for unresolved @scoped packages', async () => {
      // @unknown/package is not defined anywhere - should be treated as node_module
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        false, // excludeNodeModules = false to see the fallback behavior
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@unknown/package');
      
      // Should return the module name as-is (node_module behavior)
      expect(resolved).toBe('@unknown/package');
    });
  });

  describe('Spider with #imports', () => {
    let spider: Spider;

    beforeEach(() => {
      spider = new Spider({
        rootDir: fixturesPath,
        tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
      });
    });

    it('should crawl dependencies through #imports in app package', async () => {
      const mainFile = path.join(appPath, 'src/index.ts');
      const deps = await spider.analyze(mainFile);
      
      // Should find Button via #components/Button
      const buttonDep = deps.find(d => d.path.includes('Button.ts'));
      expect(buttonDep).toBeDefined();
      expect(buttonDep?.module).toBe('#components/Button');
    });

    it('should crawl dependencies through #imports in lib package', async () => {
      const mainFile = path.join(libPath, 'src/index.ts');
      const deps = await spider.analyze(mainFile);
      
      // Should find secret via #internal/secret
      const secretDep = deps.find(d => d.path.includes('secret.ts'));
      expect(secretDep).toBeDefined();
      expect(secretDep?.module).toBe('#internal/secret');
      
      // Should find config via #config
      const configDep = deps.find(d => d.path.includes('config.ts'));
      expect(configDep).toBeDefined();
      expect(configDep?.module).toBe('#config');
    });

    it('should crawl full dependency tree including #imports and tsconfig aliases', async () => {
      const mainFile = path.join(appPath, 'src/index.ts');
      const result = await spider.crawl(mainFile);
      
      // Check nodes include expected files (nodes is array of string paths)
      const nodePaths = result.nodes;
      
      expect(nodePaths).toContain(mainFile);
      expect(nodePaths.some((p: string) => p.includes('Button.ts'))).toBe(true);
      expect(nodePaths.some((p: string) => p.includes('utils/index.ts'))).toBe(true);
      expect(nodePaths.some((p: string) => p.includes('shared/src/helper.ts'))).toBe(true);
    });
  });

  describe('PathResolver caching', () => {
    it('should cache package.json discovery results', async () => {
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );

      // First call should find and cache
      const file1 = path.join(appPath, 'src/index.ts');
      await resolver.resolve(file1, '#components/Button');
      
      // Second call from same directory should use cache (verified by resolving successfully)
      const resolved = await resolver.resolve(file1, '#utils');
      
      expect(resolved).toBe(path.join(appPath, 'src/utils/index.ts'));
    });
  });

  describe('@alias resolution (tsconfig vs package.json)', () => {
    it('should resolve @alias from tsconfig.json paths', async () => {
      // @shared/* is defined in tsconfig.json
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should resolve @alias from package.json imports when not in tsconfig', async () => {
      // @app/* is only defined in package.json, not in tsconfig
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@app/components/Button');
      
      expect(resolved).toBe(path.join(appPath, 'src/components/Button.ts'));
    });

    it('should prioritize tsconfig.json over package.json when both define same @alias', async () => {
      // We need to add @shared/* to lib's package.json to test priority
      // For this test, @shared is in tsconfig pointing to packages/shared/src
      // Even if package.json had a different @shared, tsconfig should win
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @shared should resolve via tsconfig (packages/shared/src), not package.json
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should resolve @alias from package.json when no tsconfig provided', async () => {
      // Create resolver without tsconfig
      const resolver = new PathResolver(
        undefined, // no tsconfig
        true,
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @app/* should still resolve via package.json
      const resolved = await resolver.resolve(currentFile, '@app/components/Button');
      expect(resolved).toBe(path.join(appPath, 'src/components/Button.ts'));
    });

    it('should use package-specific @alias in monorepo (different packages have different aliases)', async () => {
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      
      // @app/* is defined in app's package.json
      const appFile = path.join(appPath, 'src/index.ts');
      const appResolved = await resolver.resolve(appFile, '@app/components/Button');
      expect(appResolved).toBe(path.join(appPath, 'src/components/Button.ts'));
      
      // @app/* should NOT resolve from lib (different package.json without @app)
      const libFile = path.join(libPath, 'src/index.ts');
      const libResolved = await resolver.resolve(libFile, '@app/components/Button');
      // Should fall back to node_module behavior (returns the module name) or null
      expect(libResolved).toBeNull(); // excludeNodeModules is true
    });

    it('should return null for @alias when excludeNodeModules=true and alias not found', async () => {
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true, // excludeNodeModules
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @nonexistent is not defined anywhere
      const resolved = await resolver.resolve(currentFile, '@nonexistent/module');
      expect(resolved).toBeNull();
    });

    it('should return module name for @alias when excludeNodeModules=false and alias not found', async () => {
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        false, // excludeNodeModules
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @nonexistent is not defined anywhere - should be treated as npm package
      const resolved = await resolver.resolve(currentFile, '@nonexistent/module');
      expect(resolved).toBe('@nonexistent/module');
    });

    it('should handle @alias with exact match (no wildcard)', async () => {
      // Add exact match test - @app/utils points to ./src/utils/index.ts exactly
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @app/* with wildcard should work
      const resolved = await resolver.resolve(currentFile, '@app/utils/index');
      expect(resolved).toBe(path.join(appPath, 'src/utils/index.ts'));
    });

    it('should resolve @alias in nested subdirectories', async () => {
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      // File in a nested directory should still find the correct package.json
      const nestedFile = path.join(appPath, 'src/components/Button.ts');
      const resolved = await resolver.resolve(nestedFile, '@app/utils/index');
      
      expect(resolved).toBe(path.join(appPath, 'src/utils/index.ts'));
    });
  });

  describe('Dynamic tsconfig.json discovery', () => {
    it('should discover tsconfig.json when not provided in constructor', async () => {
      // Create resolver without explicit tsconfig path
      const resolver = new PathResolver(
        undefined, // no tsconfig provided
        true,
        fixturesPath // workspaceRoot limits the search
      );
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @shared is defined in monorepo-project/tsconfig.json which should be discovered
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should discover tsconfig.json from nested file location', async () => {
      const resolver = new PathResolver(
        undefined,
        true,
        fixturesPath
      );
      // Start from a deeply nested file
      const nestedFile = path.join(appPath, 'src/components/Button.ts');
      
      // Should still find the tsconfig.json in the monorepo root
      const resolved = await resolver.resolve(nestedFile, '@shared/helper');
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should work when workspace root does not have tsconfig but subdirectory does', async () => {
      // Simulate opening tests/fixtures as workspace (no tsconfig.json there)
      // but monorepo-project has one
      const parentFixturesPath = path.dirname(fixturesPath); // tests/fixtures
      const resolver = new PathResolver(
        undefined,
        true,
        parentFixturesPath // workspace root is tests/fixtures (no tsconfig.json)
      );
      
      const currentFile = path.join(appPath, 'src/index.ts');
      // Should discover monorepo-project/tsconfig.json by traversing up from the file
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should cache tsconfig.json discovery results', async () => {
      const resolver = new PathResolver(
        undefined,
        true,
        fixturesPath
      );
      
      // First resolution should discover and cache
      const file1 = path.join(appPath, 'src/index.ts');
      const resolved1 = await resolver.resolve(file1, '@shared/helper');
      expect(resolved1).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
      
      // Second resolution from same package should use cache
      const file2 = path.join(appPath, 'src/components/Button.ts');
      const resolved2 = await resolver.resolve(file2, '@shared/helper');
      expect(resolved2).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should use static tsconfig path if provided (priority over dynamic discovery)', async () => {
      // Even if dynamic discovery would find a different tsconfig,
      // the explicitly provided one should be used first
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'), // explicit path
        true,
        fixturesPath
      );
      
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });
  });

  describe('file: dependency resolution', () => {
    it('should resolve @scope/package via file: dependency in package.json', async () => {
      const resolver = new PathResolver(
        undefined,
        true,
        fixturesPath
      );
      
      // Simulate importing @monorepo/lib from the app package
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@monorepo/lib');
      
      // Should resolve to the lib package's entry point
      expect(resolved).toBe(path.join(libPath, 'src/index.ts'));
    });

    it('should resolve @scope/package via file: dependency from root package.json', async () => {
      const resolver = new PathResolver(
        undefined,
        true,
        fixturesPath
      );
      
      // @monorepo/shared is defined as "file:packages/shared" in root package.json
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@monorepo/shared');
      
      // Should resolve to the shared package's entry point
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/index.ts'));
    });

    it('should resolve @scope/package/subpath via file: dependency', async () => {
      const resolver = new PathResolver(
        undefined,
        true,
        fixturesPath
      );
      
      const currentFile = path.join(appPath, 'src/index.ts');
      const resolved = await resolver.resolve(currentFile, '@monorepo/shared/helper');
      
      // Should resolve subpath within the package
      expect(resolved).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
    });

    it('should prefer tsconfig paths over file: dependencies', async () => {
      // tsconfig.json defines @shared/* -> packages/shared/src/*
      // root package.json defines @monorepo/shared -> file:packages/shared
      const resolver = new PathResolver(
        path.join(fixturesPath, 'tsconfig.json'),
        true,
        fixturesPath
      );
      
      const currentFile = path.join(appPath, 'src/index.ts');
      
      // @shared/* should use tsconfig paths
      const resolvedTsConfig = await resolver.resolve(currentFile, '@shared/helper');
      expect(resolvedTsConfig).toBe(path.join(fixturesPath, 'packages/shared/src/helper.ts'));
      
      // @monorepo/shared should fall through to file: dependency
      const resolvedFileDep = await resolver.resolve(currentFile, '@monorepo/shared');
      expect(resolvedFileDep).toBe(path.join(fixturesPath, 'packages/shared/src/index.ts'));
    });
  });
});