import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AstWorkerHost } from '../../src/analyzer/ast/AstWorkerHost';
import * as path from 'node:path';

describe('AstWorkerHost', () => {
  let workerHost: AstWorkerHost;

  beforeAll(async () => {
    // Point to the built worker file
    const workerPath = path.join(__dirname, '../../dist/astWorker.js');
    workerHost = new AstWorkerHost(workerPath);
    await workerHost.start();
  });

  afterAll(async () => {
    await workerHost.stop();
  });

  it('should analyze file and extract symbols', async () => {
    const content = `
export function myFunction() {
  return 42;
}

export const anotherFunction = () => {
  return 'hello';
};
`;

    const result = await workerHost.analyzeFile('/test.ts', content);

    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0].name).toBe('myFunction');
    expect(result.symbols[0].isExported).toBe(true);
    expect(result.symbols[1].name).toBe('anotherFunction');
    expect(result.symbols[1].isExported).toBe(true);
  });

  it('should extract signatures', async () => {
    const content = `
export function myFunction(a: string, b?: number): boolean {
  return true;
}

export class MyClass {
  method(x: number): void {
    console.log(x);
  }
}
`;

    const signatures = await workerHost.extractSignatures('/test.ts', content);

    expect(signatures.length).toBeGreaterThanOrEqual(2);
    const funcSig = signatures.find((s) => s.name === 'myFunction');
    expect(funcSig).toBeDefined();
    expect(funcSig?.parameters).toHaveLength(2);
    expect(funcSig?.parameters[0].name).toBe('a');
    expect(funcSig?.parameters[0].type).toBe('string');
    expect(funcSig?.parameters[0].isOptional).toBe(false);
    expect(funcSig?.parameters[1].name).toBe('b');
    expect(funcSig?.parameters[1].isOptional).toBe(true);
  });

  it('should detect breaking changes', async () => {
    const oldContent = `
export function myFunction(a: string): string {
  return a.toUpperCase();
}
`;

    const newContent = `
export function myFunction(a: string, b: number): string {
  return a.toUpperCase() + b;
}
`;

    const results = await workerHost.analyzeBreakingChanges(
      '/test.ts',
      oldContent,
      newContent
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const funcResult = results.find((r) => r.symbolName === 'myFunction');
    expect(funcResult).toBeDefined();
    expect(funcResult?.hasBreakingChanges).toBe(true);
    expect(funcResult?.breakingChanges.length).toBeGreaterThanOrEqual(1);
    expect(funcResult?.breakingChanges[0].type).toBe('parameter-added-required');
  });

  it('should get internal export dependency graph', async () => {
    const content = `
export function helperA() {
  return 1;
}

export function mainFunction() {
  return helperA();
}
`;

    const graph = await workerHost.getInternalExportDependencyGraph('/test.ts', content);

    expect(graph.size).toBeGreaterThan(0);
    const mainDeps = graph.get('/test.ts:mainFunction');
    expect(mainDeps).toBeDefined();
    if (mainDeps) {
      expect(mainDeps.has('/test.ts:helperA')).toBe(true);
    }
  });

  it('should reset and track file count', async () => {
    // Reset first to ensure clean state
    await workerHost.reset();
    
    // Analyze multiple files
    await workerHost.analyzeFile('/file1.ts', 'export const a = 1;');
    await workerHost.analyzeFile('/file2.ts', 'export const b = 2;');
    await workerHost.analyzeFile('/file3.ts', 'export const c = 3;');

    let count = await workerHost.getFileCount();
    expect(count).toBe(3);

    // Reset should clear files
    await workerHost.reset();

    count = await workerHost.getFileCount();
    expect(count).toBe(0);
  });
});
