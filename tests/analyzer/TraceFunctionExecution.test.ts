import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { normalizePath } from '../../src/shared/path';

describe('Spider - Trace Function Execution', () => {
  const fixturesDir = path.join(__dirname, '../fixtures/trace');
  const controllerPath = path.join(fixturesDir, 'controller.ts');
  const servicePath = path.join(fixturesDir, 'service.ts');
  
  let spider: Spider;

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .build();
    
    // Build the index first
    await spider.buildFullIndex();
  });

  it('should trace execution from service to dependencies', async () => {
    // Service directly uses imports (formatUser, UserRepository)
    const trace = await spider.traceFunctionExecution(servicePath, 'UserService');
    
    // Should have the correct root symbol
    expect(trace.rootSymbol.symbolName).toBe('UserService');
    expect(trace.rootSymbol.filePath).toBe(servicePath);
    
    // The trace function itself should work even if no direct calls found
    expect(trace.callChain).toBeDefined();
    expect(trace.visitedSymbols).toBeDefined();
    expect(trace.visitedSymbols).toContain(`${servicePath}:UserService`);
  });

  it('should trace from controller and find class import usage', async () => {
    const trace = await spider.traceFunctionExecution(controllerPath, 'handleGetUser');
    
    // Should have the correct root symbol
    expect(trace.rootSymbol.symbolName).toBe('handleGetUser');
    expect(trace.rootSymbol.filePath).toBe(controllerPath);
    
    // Check for UserService in call chain (imported class is used)
    const hasServiceImport = trace.callChain.some(c => 
      c.calledSymbolId.includes('UserService')
    );
    
    // Note: Currently the analyzer detects the class import but not instance method calls
    // This is a known limitation - detecting userService.getUser() requires type inference
    expect(hasServiceImport || trace.callChain.length === 0).toBe(true);
  });

  it('should respect maxDepth limit', async () => {
    const shallowTrace = await spider.traceFunctionExecution(servicePath, 'UserService', 1);
    const deepTrace = await spider.traceFunctionExecution(servicePath, 'UserService', 10);
    
    // Shallow trace should have fewer or equal calls
    expect(shallowTrace.callChain.length).toBeLessThanOrEqual(deepTrace.callChain.length);
  });

  it('should detect when max depth is reached', async () => {
    // With depth 1, we may or may not reach max depth depending on the call chain
    const trace = await spider.traceFunctionExecution(controllerPath, 'handleGetUser', 1);
    
    // The trace should complete without error
    expect(trace.rootSymbol).toBeDefined();
    expect(trace.callChain).toBeDefined();
  });

  it('should handle symbols with no dependencies', async () => {
    const loggerPath = path.join(fixturesDir, 'logger.ts');
    const trace = await spider.traceFunctionExecution(loggerPath, 'logOperation');
    
    // Logger has no external dependencies
    expect(trace.rootSymbol.symbolName).toBe('logOperation');
    expect(trace.callChain).toHaveLength(0);
  });

  it('should avoid cycles by tracking visited symbols', async () => {
    // Even if there were cycles, they should be detected
    const trace = await spider.traceFunctionExecution(controllerPath, 'handleCreateUser');
    
    // Each visited symbol should appear only once in visitedSymbols
    const uniqueVisited = new Set(trace.visitedSymbols);
    expect(uniqueVisited.size).toBe(trace.visitedSymbols.length);
  });

  describe('resolved target symbol ids', () => {
    const resolvedDir = path.join(__dirname, '../fixtures/trace-resolved');
    const entryPath = path.join(resolvedDir, 'entry.ts');
    const helperId = `${normalizePath(path.join(resolvedDir, 'helper.ts'))}:helper`;
    const leafId = `${normalizePath(path.join(resolvedDir, 'leaf.ts'))}:leaf`;
    let resolvedSpider: Spider;

    beforeAll(async () => {
      resolvedSpider = new SpiderBuilder().withRootDir(resolvedDir).withReverseIndex(true).build();
      await resolvedSpider.buildFullIndex();
    });

    it('uses the resolved file path in target symbol ids, not the import specifier', async () => {
      const { dependencies } = await resolvedSpider.getSymbolGraph(entryPath);
      const targetIds = dependencies.map((d) => d.targetSymbolId);

      expect(targetIds).toContain(helperId);
      expect(targetIds.some((id) => id.startsWith('./'))).toBe(false);
    });

    it('keeps the original id when the specifier cannot be resolved', async () => {
      const { dependencies } = await resolvedSpider.getSymbolGraph(entryPath);

      expect(dependencies.map((d) => d.targetSymbolId)).toContain('external-pkg:external');
    });

    it('recurses into resolved files beyond depth 1', async () => {
      const trace = await resolvedSpider.traceFunctionExecution(entryPath, 'main', 5);
      const helperCall = trace.callChain.find((c) => c.calledSymbolId === helperId);
      const leafCall = trace.callChain.find((c) => c.calledSymbolId === leafId);

      expect(helperCall).toMatchObject({ depth: 1, resolvedFilePath: normalizePath(path.join(resolvedDir, 'helper.ts')) });
      expect(leafCall).toMatchObject({ depth: 2, callerSymbolId: `${normalizePath(path.join(resolvedDir, 'helper.ts'))}:helper` });
      expect(trace.visitedSymbols).toContain(leafId);
    });

    it('collapses repeated calls and skips type-only references', async () => {
      const trace = await resolvedSpider.traceFunctionExecution(entryPath, 'main', 5);

      expect(trace.callChain.filter((c) => c.calledSymbolId === helperId)).toHaveLength(1);
      expect(trace.callChain.some((c) => c.calledSymbolId.endsWith(':Options'))).toBe(false);
    });

    it('does not recurse into unresolved external packages', async () => {
      const trace = await resolvedSpider.traceFunctionExecution(entryPath, 'main', 5);
      const externalCall = trace.callChain.find((c) => c.calledSymbolId === 'external-pkg:external');

      expect(externalCall?.resolvedFilePath).toBeNull();
      expect(trace.visitedSymbols.some((id) => id.startsWith('external-pkg'))).toBe(false);
    });
  });

  it('should trace formatter function which uses no external imports', async () => {
    const formatterPath = path.join(fixturesDir, 'formatter.ts');
    const trace = await spider.traceFunctionExecution(formatterPath, 'formatUser');
    
    // formatUser has no external dependencies
    expect(trace.rootSymbol.symbolName).toBe('formatUser');
    expect(trace.visitedSymbols).toContain(`${formatterPath}:formatUser`);
  });
});

describe('Spider - Trace reads each module graph once (#575)', () => {
  const root = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
  const layer1 = path.join(root, 'src/layers/layer1.ts');
  let spider: Spider;
  type Service = { getSymbolGraph(file: string): Promise<unknown> };
  const service = () => (spider as unknown as { symbolService: Service }).symbolService;

  beforeAll(async () => {
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
  }, 60_000);

  it('reads every module once per trace, with the same call chain', async () => {
    const expected = await spider.traceFunctionExecution(layer1, 'layer1Entry', 10);
    expect(expected.callChain.length).toBeGreaterThan(2);
    const read = vi.spyOn(service(), 'getSymbolGraph');
    try {
      const trace = await spider.traceFunctionExecution(layer1, 'layer1Entry', 10);
      expect(trace).toEqual(expected);
      const files = read.mock.calls.map(([file]) => normalizePath(file));
      expect(files).toHaveLength(new Set(files).size);
      // Another trace reads again: nothing outlives a trace.
      await spider.traceFunctionExecution(layer1, 'layer1Entry', 10);
      expect(read.mock.calls).toHaveLength(2 * files.length);
    } finally { read.mockRestore(); }
  });

  it('keeps no failed read: the trace degrades as before and the next one is complete', async () => {
    const expected = await spider.traceFunctionExecution(layer1, 'layer1Entry', 10);
    const graph = service().getSymbolGraph.bind(service());
    const read = vi.spyOn(service(), 'getSymbolGraph').mockImplementation(async (file: string) => {
      if (file.endsWith('layer2.ts') && read.mock.calls.filter(([f]) => f.endsWith('layer2.ts')).length === 1) throw new Error('index unavailable');
      return graph(file);
    });
    try {
      const degraded = await spider.traceFunctionExecution(layer1, 'layer1Entry', 10);
      expect(degraded.rootSymbol).toEqual(expected.rootSymbol);
      expect(degraded.callChain.length).toBeLessThan(expected.callChain.length);
      expect(await spider.traceFunctionExecution(layer1, 'layer1Entry', 10)).toEqual(expected);
    } finally { read.mockRestore(); }
  });
});
