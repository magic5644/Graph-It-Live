import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '@/analyzer/Spider';
import path from 'node:path';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

describe('Spider', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new Spider({
      rootDir: fixturesPath,
      tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
    });
  });

  it('should resolve relative imports', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    expect(deps.length).toBeGreaterThan(0);
    
    const utilsDep = deps.find(d => d.path.includes('utils.ts'));
    expect(utilsDep).toBeDefined();
    expect(utilsDep?.type).toBe('import');
    expect(utilsDep?.module).toBe('./utils');
  });

  it('should resolve TypeScript path aliases', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    const buttonDep = deps.find(d => d.path.includes('Button.tsx'));
    expect(buttonDep).toBeDefined();
    expect(buttonDep?.type).toBe('import');
    expect(buttonDep?.module).toBe('@components/Button');
  });

  it('should resolve imports with implicit extensions', async () => {
    const buttonFile = path.join(fixturesPath, 'src/components/Button.tsx');
    const deps = await spider.analyze(buttonFile);
    
    const utilsDep = deps.find(d => d.path.includes('utils'));
    expect(utilsDep).toBeDefined();
    expect(path.extname(utilsDep!.path)).toBe('.ts');
  });

  it('should cache results for performance', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    const start1 = Date.now();
    const deps1 = await spider.analyze(mainFile);
    const time1 = Date.now() - start1;
    
    const start2 = Date.now();
    const deps2 = await spider.analyze(mainFile);
    const time2 = Date.now() - start2;
    
    expect(deps1).toEqual(deps2);
    expect(time2).toBeLessThan(time1 || 10); // Cached should be faster or both very fast
  });

  it('should handle non-existent files gracefully', async () => {
    const fakeFile = path.join(fixturesPath, 'src/does-not-exist.ts');
    
    await expect(spider.analyze(fakeFile)).rejects.toThrow();
  });

  it('should detect multiple imports in single file', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    // main.ts has 2 imports: utils and Button
    expect(deps.length).toBe(2);
  });

  it('should preserve line numbers', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    deps.forEach(dep => {
      expect(dep.line).toBeGreaterThan(0);
    });
  });
});
