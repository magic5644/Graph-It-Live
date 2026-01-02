import { describe, it, expect, beforeEach } from 'vitest';
import { LanguageService, Language } from '@/analyzer/LanguageService';

describe('LanguageService', () => {
  beforeEach(() => {
    // Reset cached analyzers before each test
    LanguageService.reset();
  });

  describe('detectLanguage', () => {
    it('should detect TypeScript files', () => {
      expect(LanguageService.detectLanguage('/project/file.ts')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/component.tsx')).toBe(Language.TypeScript);
    });

    it('should detect JavaScript files', () => {
      expect(LanguageService.detectLanguage('/project/file.js')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/component.jsx')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/module.mjs')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/module.cjs')).toBe(Language.TypeScript);
    });

    it('should detect Vue/Svelte files as TypeScript', () => {
      expect(LanguageService.detectLanguage('/project/Component.vue')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/Component.svelte')).toBe(Language.TypeScript);
    });

    it('should detect GraphQL files as TypeScript', () => {
      expect(LanguageService.detectLanguage('/project/schema.gql')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/query.graphql')).toBe(Language.TypeScript);
    });

    it('should detect Python files', () => {
      expect(LanguageService.detectLanguage('/project/main.py')).toBe(Language.Python);
      expect(LanguageService.detectLanguage('/project/types.pyi')).toBe(Language.Python);
    });

    it('should detect Rust files', () => {
      expect(LanguageService.detectLanguage('/project/main.rs')).toBe(Language.Rust);
      expect(LanguageService.detectLanguage('/project/Cargo.toml')).toBe(Language.Rust);
    });

    it('should return Unknown for unsupported extensions', () => {
      expect(LanguageService.detectLanguage('/project/file.txt')).toBe(Language.Unknown);
      expect(LanguageService.detectLanguage('/project/README.md')).toBe(Language.Unknown);
    });

    it('should be case-insensitive', () => {
      expect(LanguageService.detectLanguage('/project/FILE.TS')).toBe(Language.TypeScript);
      expect(LanguageService.detectLanguage('/project/MAIN.PY')).toBe(Language.Python);
      expect(LanguageService.detectLanguage('/project/LIB.RS')).toBe(Language.Rust);
    });
  });

  describe('getAnalyzer', () => {
    it('should return TypeScript parser for .ts files', () => {
      const analyzer = LanguageService.getAnalyzer('/project/file.ts');
      expect(analyzer).toBeDefined();
      expect(analyzer.parseImports).toBeDefined();
      expect(analyzer.resolvePath).toBeDefined();
    });

    it('should return the same instance for multiple TypeScript files (singleton)', () => {
      const analyzer1 = LanguageService.getAnalyzer('/project/file1.ts');
      const analyzer2 = LanguageService.getAnalyzer('/project/file2.ts');
      expect(analyzer1).toBe(analyzer2);
    });

    it('should throw error for Python files (not yet implemented)', () => {
      const analyzer = LanguageService.getAnalyzer('/project/main.py');
      expect(analyzer).toBeDefined();
      expect(analyzer.parseImports).toBeDefined();
    });

    it('should throw error for Rust files (not yet implemented)', () => {
      expect(() => LanguageService.getAnalyzer('/project/main.rs')).toThrow(
        'Rust parser not yet implemented'
      );
    });

    it('should throw error for unsupported files', () => {
      expect(() => LanguageService.getAnalyzer('/project/file.txt')).toThrow(
        'Unsupported language for file'
      );
    });
  });

  describe('getSymbolAnalyzer', () => {
    it('should return TypeScript symbol analyzer for .ts files', () => {
      const analyzer = LanguageService.getSymbolAnalyzer('/project/file.ts');
      expect(analyzer).toBeDefined();
      expect(analyzer.analyzeFile).toBeDefined();
      expect(analyzer.getSymbolDependencies).toBeDefined();
    });

    it('should return the same instance for multiple TypeScript files (singleton)', () => {
      const analyzer1 = LanguageService.getSymbolAnalyzer('/project/file1.ts');
      const analyzer2 = LanguageService.getSymbolAnalyzer('/project/file2.ts');
      expect(analyzer1).toBe(analyzer2);
    });

    it('should return PythonSymbolAnalyzer for Python files', () => {
      const analyzer = LanguageService.getSymbolAnalyzer('/project/main.py');
      expect(analyzer).toBeDefined();
      expect(analyzer.constructor.name).toBe('PythonSymbolAnalyzer');
    });

    it('should throw error for Rust files (not yet implemented)', () => {
      expect(() => LanguageService.getSymbolAnalyzer('/project/main.rs')).toThrow(
        'Rust symbol analyzer not yet implemented'
      );
    });
  });

  describe('isSupported', () => {
    it('should return true for supported file types', () => {
      expect(LanguageService.isSupported('/project/file.ts')).toBe(true);
      expect(LanguageService.isSupported('/project/file.js')).toBe(true);
      expect(LanguageService.isSupported('/project/main.py')).toBe(true);
      expect(LanguageService.isSupported('/project/main.rs')).toBe(true);
    });

    it('should return false for unsupported file types', () => {
      expect(LanguageService.isSupported('/project/file.txt')).toBe(false);
      expect(LanguageService.isSupported('/project/README.md')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should clear cached analyzers', () => {
      const analyzer1 = LanguageService.getAnalyzer('/project/file.ts');
      LanguageService.reset();
      const analyzer2 = LanguageService.getAnalyzer('/project/file.ts');
      expect(analyzer1).not.toBe(analyzer2);
    });
  });
});
