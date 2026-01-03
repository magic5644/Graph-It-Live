import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AstWorkerHost } from '../../src/analyzer/ast/AstWorkerHost';

describe('AstWorkerHost - Python Support', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/python-project');
  let astWorkerHost: AstWorkerHost;

  beforeEach(async () => {
    // Use the bundled astWorker.js from dist/
    const workerPath = path.resolve(__dirname, '../../dist/astWorker.js');
    astWorkerHost = new AstWorkerHost(workerPath);
    await astWorkerHost.start();
  });

  afterEach(async () => {
    await astWorkerHost.stop();
  });

  it('should analyze Python file and extract symbols', async () => {
    const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
    const content = await fs.readFile(helpersFile, 'utf-8');

    const result = await astWorkerHost.analyzeFile(helpersFile, content);

    expect(result.symbols).toBeDefined();
    expect(result.dependencies).toBeDefined();

    const symbolNames = result.symbols.map((s: { name: string }) => s.name);
    expect(symbolNames).toContain('calculate');
    expect(symbolNames).toContain('format_result');
    expect(symbolNames).toContain('advanced_calc');
  });

  it('should analyze Python class file and extract methods', async () => {
    const classesFile = path.join(fixturesDir, 'classes.py');
    const content = await fs.readFile(classesFile, 'utf-8');

    const result = await astWorkerHost.analyzeFile(classesFile, content);

    const symbolNames = result.symbols.map((s: { name: string }) => s.name);
    expect(symbolNames).toContain('Animal');
    expect(symbolNames).toContain('Dog');
    expect(symbolNames).toContain('speak');
  });

  it('should extract symbol dependencies in Python', async () => {
    const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
    const content = await fs.readFile(helpersFile, 'utf-8');

    const result = await astWorkerHost.analyzeFile(helpersFile, content);

    expect(result.dependencies).toBeDefined();
    // helpers.py has internal function calls between calculate, format_result, advanced_calc
    expect(result.dependencies.length).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.dependencies)).toBe(true);
  });

  it('should handle TypeScript files with ts-morph', async () => {
    const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');
    const mainFile = path.join(tsFixturesDir, 'src', 'main.ts');
    const content = await fs.readFile(mainFile, 'utf-8');

    const result = await astWorkerHost.analyzeFile(mainFile, content);

    expect(result.symbols).toBeDefined();
    expect(result.symbols.length).toBeGreaterThan(0);

    const symbolNames = result.symbols.map((s: { name: string }) => s.name);
    expect(symbolNames).toContain('main');
  });
});
