/**
 * Tests for language detection utilities
 */

import { describe, expect, it } from 'vitest';
import {
    detectLanguageFromExtension,
    getExtensionsForLanguage,
    isLanguage,
    LANGUAGE_BY_EXTENSION,
} from '../../src/shared/utils/languageDetection';

describe('languageDetection', () => {
  describe('LANGUAGE_BY_EXTENSION', () => {
    it('should have all expected language mappings', () => {
      expect(LANGUAGE_BY_EXTENSION['.ts']).toBe('typescript');
      expect(LANGUAGE_BY_EXTENSION['.tsx']).toBe('typescript');
      expect(LANGUAGE_BY_EXTENSION['.js']).toBe('javascript');
      expect(LANGUAGE_BY_EXTENSION['.jsx']).toBe('javascript');
      expect(LANGUAGE_BY_EXTENSION['.py']).toBe('python');
      expect(LANGUAGE_BY_EXTENSION['.pyi']).toBe('python');
      expect(LANGUAGE_BY_EXTENSION['.rs']).toBe('rust');
      expect(LANGUAGE_BY_EXTENSION['.vue']).toBe('vue');
      expect(LANGUAGE_BY_EXTENSION['.svelte']).toBe('svelte');
      expect(LANGUAGE_BY_EXTENSION['.gql']).toBe('graphql');
      expect(LANGUAGE_BY_EXTENSION['.graphql']).toBe('graphql');
    });
  });

  describe('detectLanguageFromExtension', () => {
    it('should detect language from file path', () => {
      expect(detectLanguageFromExtension('/path/to/file.ts')).toBe('typescript');
      expect(detectLanguageFromExtension('/path/to/file.tsx')).toBe('typescript');
      expect(detectLanguageFromExtension('/path/to/file.js')).toBe('javascript');
      expect(detectLanguageFromExtension('/path/to/file.jsx')).toBe('javascript');
      expect(detectLanguageFromExtension('/path/to/file.py')).toBe('python');
      expect(detectLanguageFromExtension('/path/to/file.pyi')).toBe('python');
      expect(detectLanguageFromExtension('/path/to/file.rs')).toBe('rust');
    });

    it('should detect language from extension with dot', () => {
      expect(detectLanguageFromExtension('.ts')).toBe('typescript');
      expect(detectLanguageFromExtension('.tsx')).toBe('typescript');
      expect(detectLanguageFromExtension('.js')).toBe('javascript');
      expect(detectLanguageFromExtension('.jsx')).toBe('javascript');
      expect(detectLanguageFromExtension('.py')).toBe('python');
      expect(detectLanguageFromExtension('.rs')).toBe('rust');
    });

    it('should detect language from extension without dot', () => {
      expect(detectLanguageFromExtension('ts')).toBe('typescript');
      expect(detectLanguageFromExtension('tsx')).toBe('typescript');
      expect(detectLanguageFromExtension('js')).toBe('javascript');
      expect(detectLanguageFromExtension('jsx')).toBe('javascript');
      expect(detectLanguageFromExtension('py')).toBe('python');
      expect(detectLanguageFromExtension('rs')).toBe('rust');
    });

    it('should be case insensitive', () => {
      expect(detectLanguageFromExtension('.TS')).toBe('typescript');
      expect(detectLanguageFromExtension('.TSX')).toBe('typescript');
      expect(detectLanguageFromExtension('.JS')).toBe('javascript');
      expect(detectLanguageFromExtension('.PY')).toBe('python');
      expect(detectLanguageFromExtension('.RS')).toBe('rust');
    });

    it('should return "unknown" for unsupported extensions', () => {
      expect(detectLanguageFromExtension('.txt')).toBe('unknown');
      expect(detectLanguageFromExtension('.md')).toBe('unknown');
      expect(detectLanguageFromExtension('.json')).toBe('unknown');
      expect(detectLanguageFromExtension('/path/to/file.unknown')).toBe('unknown');
    });

    it('should handle Windows paths', () => {
      expect(detectLanguageFromExtension('C:\\path\\to\\file.ts')).toBe('typescript');
      expect(detectLanguageFromExtension('C:\\path\\to\\file.py')).toBe('python');
    });
  });

  describe('isLanguage', () => {
    it('should check if file is a specific language', () => {
      expect(isLanguage('/path/to/file.ts', 'typescript')).toBe(true);
      expect(isLanguage('/path/to/file.tsx', 'typescript')).toBe(true);
      expect(isLanguage('/path/to/file.js', 'javascript')).toBe(true);
      expect(isLanguage('/path/to/file.py', 'python')).toBe(true);
      expect(isLanguage('/path/to/file.rs', 'rust')).toBe(true);
    });

    it('should return false for wrong language', () => {
      expect(isLanguage('/path/to/file.ts', 'javascript')).toBe(false);
      expect(isLanguage('/path/to/file.js', 'typescript')).toBe(false);
      expect(isLanguage('/path/to/file.py', 'rust')).toBe(false);
    });

    it('should work with extensions', () => {
      expect(isLanguage('.ts', 'typescript')).toBe(true);
      expect(isLanguage('ts', 'typescript')).toBe(true);
      expect(isLanguage('.py', 'python')).toBe(true);
    });
  });

  describe('getExtensionsForLanguage', () => {
    it('should return all extensions for typescript', () => {
      const extensions = getExtensionsForLanguage('typescript');
      expect(extensions).toContain('.ts');
      expect(extensions).toContain('.tsx');
      expect(extensions).toContain('.mts');
      expect(extensions).toContain('.cts');
      expect(extensions.length).toBe(4);
    });

    it('should return all extensions for javascript', () => {
      const extensions = getExtensionsForLanguage('javascript');
      expect(extensions).toContain('.js');
      expect(extensions).toContain('.jsx');
      expect(extensions).toContain('.mjs');
      expect(extensions).toContain('.cjs');
      expect(extensions.length).toBe(4);
    });

    it('should return all extensions for python', () => {
      const extensions = getExtensionsForLanguage('python');
      expect(extensions).toContain('.py');
      expect(extensions).toContain('.pyi');
      expect(extensions.length).toBe(2);
    });

    it('should return all extensions for rust', () => {
      const extensions = getExtensionsForLanguage('rust');
      expect(extensions).toContain('.rs');
      expect(extensions.length).toBe(1);
    });

    it('should return empty array for unknown language', () => {
      const extensions = getExtensionsForLanguage('unknown');
      expect(extensions).toEqual([]);
    });
  });

  describe('Integration with SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS', () => {
    it('should support all symbol analysis extensions', () => {
      const symbolAnalysisExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs'];
      
      for (const ext of symbolAnalysisExtensions) {
        const language = detectLanguageFromExtension(ext);
        expect(language).not.toBe('unknown');
      }
    });

    it('should map symbol analysis extensions to correct languages', () => {
      expect(detectLanguageFromExtension('.ts')).toBe('typescript');
      expect(detectLanguageFromExtension('.tsx')).toBe('typescript');
      expect(detectLanguageFromExtension('.js')).toBe('javascript');
      expect(detectLanguageFromExtension('.jsx')).toBe('javascript');
      expect(detectLanguageFromExtension('.py')).toBe('python');
      expect(detectLanguageFromExtension('.rs')).toBe('rust');
    });
  });
});
