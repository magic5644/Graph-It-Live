import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { PythonSymbolAnalyzer } from '@/analyzer/languages/PythonSymbolAnalyzer';
import { normalizePath } from '@/shared/path';

describe('PythonSymbolAnalyzer', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/python-project');
  let analyzer: PythonSymbolAnalyzer;

  beforeEach(() => {
    analyzer = new PythonSymbolAnalyzer(fixturesDir);
  });

  describe('analyzeFile', () => {
    it('should extract function definitions', async () => {
      const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
      const symbols = await analyzer.analyzeFile(helpersFile);

      const symbolNames = Array.from(symbols.values()).map(s => s.name);
      expect(symbolNames).toContain('calculate');
      expect(symbolNames).toContain('format_result');
      expect(symbolNames).toContain('advanced_calc');
    });

    it('should extract class definitions', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const symbols = await analyzer.analyzeFile(classesFile);

      const symbolNames = Array.from(symbols.values()).map(s => s.name);
      expect(symbolNames).toContain('Animal');
      expect(symbolNames).toContain('Dog');
    });

    it('should extract class methods', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const symbols = await analyzer.analyzeFile(classesFile);

      const symbolArray = Array.from(symbols.values());
      const speakMethod = symbolArray.find(s => s.name === 'speak');
      expect(speakMethod).toBeDefined();
      expect(speakMethod?.category).toBe('function');
    });

    it('should mark functions as exported if not starting with underscore', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const symbols = await analyzer.analyzeFile(classesFile);

      const symbolArray = Array.from(symbols.values());
      const publicMethod = symbolArray.find(s => s.name === 'speak');
      const privateMethod = symbolArray.find(s => s.name === '_private_method');

      expect(publicMethod?.isExported).toBe(true);
      expect(privateMethod?.isExported).toBe(false);
    });

    it('should handle decorated functions', async () => {
      const decoratorsFile = path.join(fixturesDir, 'decorators.py');
      const symbols = await analyzer.analyzeFile(decoratorsFile);

      const symbolNames = Array.from(symbols.values()).map(s => s.name);
      expect(symbolNames).toContain('decorated_function');
      expect(symbolNames).toContain('my_decorator');
    });

    it('should handle async functions', async () => {
      const asyncFile = path.join(fixturesDir, 'async_functions.py');
      const symbols = await analyzer.analyzeFile(asyncFile);

      const symbolArray = Array.from(symbols.values());
      const asyncFunc = symbolArray.find(s => s.name === 'async_function');
      const syncFunc = symbolArray.find(s => s.name === 'sync_function');

      expect(asyncFunc).toBeDefined();
      expect(asyncFunc?.kind).toBe('AsyncFunction');
      expect(syncFunc).toBeDefined();
      expect(syncFunc?.kind).toBe('FunctionDeclaration');
    });

    it('should handle nested functions', async () => {
      const decoratorsFile = path.join(fixturesDir, 'decorators.py');
      const symbols = await analyzer.analyzeFile(decoratorsFile);

      const symbolArray = Array.from(symbols.values());
      const wrapper = symbolArray.find(s => s.name === 'wrapper');
      expect(wrapper).toBeDefined();
      expect(wrapper?.parentSymbolId).toBeDefined();
    });

    it('should map symbols to correct categories', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const symbols = await analyzer.analyzeFile(classesFile);

      const symbolArray = Array.from(symbols.values());
      const classSymbol = symbolArray.find(s => s.name === 'Animal');
      const functionSymbol = symbolArray.find(s => s.name === 'create_dog');

      expect(classSymbol?.category).toBe('class');
      expect(functionSymbol?.category).toBe('function');
    });

    it('should generate correct symbol IDs', async () => {
      const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
      const symbols = await analyzer.analyzeFile(helpersFile);

      const normalizedPath = normalizePath(helpersFile);
      const symbolIds = Array.from(symbols.keys());
      
      expect(symbolIds.every(id => id.startsWith(normalizedPath))).toBe(true);
      expect(symbolIds.some(id => id.includes(':calculate'))).toBe(true);
    });
  });

  describe('getSymbolDependencies', () => {
    it('should track function calls within same file', async () => {
      const asyncFile = path.join(fixturesDir, 'async_functions.py');
      const deps = await analyzer.getSymbolDependencies(asyncFile);

      const normalizedPath = normalizePath(asyncFile);
      const asyncFuncId = `${normalizedPath}:async_function`;
      const helperId = `${normalizedPath}:helper`;

      const dependency = deps.find(d => 
        d.sourceSymbolId === asyncFuncId && 
        d.targetSymbolId === helperId
      );

      expect(dependency).toBeDefined();
      expect(dependency?.isTypeOnly).toBe(false);
    });

    it('should track method calls within class', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const deps = await analyzer.getSymbolDependencies(classesFile);

      const normalizedPath = normalizePath(classesFile);
      const speakId = `${normalizedPath}:speak`;
      const formatId = `${normalizedPath}:_format_sound`;

      const dependency = deps.find(d => 
        d.sourceSymbolId === speakId && 
        d.targetSymbolId === formatId
      );

      expect(dependency).toBeDefined();
    });

    it('should not create dependencies for external calls', async () => {
      const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
      const deps = await analyzer.getSymbolDependencies(helpersFile);

      // math.sqrt is external - should not be in dependencies
      const externalDep = deps.find(d => d.targetSymbolId.includes('math'));
      expect(externalDep).toBeUndefined();
    });

    it('should include target file path in dependencies', async () => {
      const classesFile = path.join(fixturesDir, 'classes.py');
      const deps = await analyzer.getSymbolDependencies(classesFile);

      const normalizedPath = normalizePath(classesFile);
      expect(deps.every(d => d.targetFilePath === normalizedPath)).toBe(true);
    });
  });

  describe('cross-file symbol resolution', () => {
    it('should analyze files independently', async () => {
      const file1 = path.join(fixturesDir, 'utils', 'helpers.py');
      const file2 = path.join(fixturesDir, 'classes.py');

      const symbols1 = await analyzer.analyzeFile(file1);
      const symbols2 = await analyzer.analyzeFile(file2);

      expect(symbols1.size).toBeGreaterThan(0);
      expect(symbols2.size).toBeGreaterThan(0);
      
      // Symbol IDs should be file-specific
      const ids1 = Array.from(symbols1.keys());
      const ids2 = Array.from(symbols2.keys());
      expect(ids1.every(id => id.includes('helpers.py'))).toBe(true);
      expect(ids2.every(id => id.includes('classes.py'))).toBe(true);
    });
  });
});
