/**
 * Tests for MCP Payload Size Limits
 * 
 * Verifies that Zod schemas properly validate and reject oversized payloads
 * to prevent memory exhaustion and DoS attacks.
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PAYLOAD_LIMITS,
  FilePathSchema,
  SymbolNameSchema,
  FileContentSchema,
  GenericStringSchema,
  SetWorkspaceParamsSchema,
  AnalyzeBreakingChangesParamsSchema,
  GetSymbolCallersParamsSchema,
} from '../../src/mcp/types';

// Helper functions to reduce nesting depth and improve cross-platform compatibility

/**
 * Cross-platform path examples for testing
 */
function getValidPathExamples(): string[] {
  return [
    path.join('/', 'Users', 'test', 'project', 'src', 'index.ts'),
    // Windows path - use String.raw to avoid escaping issues
    String.raw`C:\Users\test\project\src\index.ts`,
    path.join('/', 'very', 'deeply', 'nested', 'directory', 'structure', 'that', 'is', 'still', 'reasonable', 'file.ts'),
  ];
}

/**
 * Test that a schema accepts valid input
 */
function expectSchemaAccepts<T>(schema: { parse: (val: T) => unknown }, value: T): void {
  expect(() => schema.parse(value)).not.toThrow();
}

/**
 * Test that a schema rejects invalid input with specific error
 */
function expectSchemaRejects<T>(
  schema: { parse: (val: T) => unknown }, 
  value: T, 
  errorPattern: RegExp
): void {
  expect(() => schema.parse(value)).toThrow(errorPattern);
}

describe('Payload Size Limits', () => {
  describe('PAYLOAD_LIMITS constants', () => {
    it('should define reasonable limits', () => {
      expect(PAYLOAD_LIMITS.FILE_PATH).toBe(1024); // 1 KB
      expect(PAYLOAD_LIMITS.SYMBOL_NAME).toBe(500); // 500 bytes
      expect(PAYLOAD_LIMITS.FILE_CONTENT).toBe(1024 * 1024); // 1 MB
      expect(PAYLOAD_LIMITS.GENERIC_STRING).toBe(10 * 1024); // 10 KB
    });
  });

  describe('FilePathSchema', () => {
    it('should accept valid file paths', () => {
      const validPaths = getValidPathExamples();
      validPaths.forEach(testPath => {
        expectSchemaAccepts(FilePathSchema, testPath);
      });
    });

    it('should reject paths exceeding 1 KB', () => {
      const oversizedPath = '/path/' + 'a'.repeat(PAYLOAD_LIMITS.FILE_PATH);
      expectSchemaRejects(FilePathSchema, oversizedPath, /File path exceeds maximum length/);
    });

    it('should reject paths with null bytes', () => {
      const pathWithNull = path.join('/path', 'to', 'file\0.ts');
      expectSchemaRejects(FilePathSchema, pathWithNull, /File path contains null bytes/);
    });
  });

  describe('SymbolNameSchema', () => {
    it('should accept valid symbol names', () => {
      const validNames = [
        'myFunction',
        'MyClass',
        'CONSTANT_VALUE',
        'someVeryLongButStillReasonableFunctionNameThatPeopleActuallyUse',
      ];

      validNames.forEach(name => {
        expectSchemaAccepts(SymbolNameSchema, name);
      });
    });

    it('should reject symbol names exceeding 500 bytes', () => {
      const oversizedName = 'a'.repeat(PAYLOAD_LIMITS.SYMBOL_NAME + 1);
      expectSchemaRejects(SymbolNameSchema, oversizedName, /Symbol name exceeds maximum length/);
    });

    it('should reject symbol names with null bytes', () => {
      const nameWithNull = 'myFunc\0tion';
      expectSchemaRejects(SymbolNameSchema, nameWithNull, /Symbol name contains null bytes/);
    });
  });

  describe('FileContentSchema', () => {
    it('should accept reasonable file content', () => {
      const smallContent = 'export function test() { return 42; }';
      const mediumContent = 'x'.repeat(50 * 1024); // 50 KB
      const largeContent = 'y'.repeat(500 * 1024); // 500 KB
      
      expectSchemaAccepts(FileContentSchema, smallContent);
      expectSchemaAccepts(FileContentSchema, mediumContent);
      expectSchemaAccepts(FileContentSchema, largeContent);
    });

    it('should reject file content exceeding 1 MB', () => {
      const oversizedContent = 'z'.repeat(PAYLOAD_LIMITS.FILE_CONTENT + 1);
      expectSchemaRejects(FileContentSchema, oversizedContent, /File content exceeds maximum size/);
    });

    it('should reject file content with null bytes', () => {
      const contentWithNull = 'export const x = 1;\0';
      expectSchemaRejects(FileContentSchema, contentWithNull, /File content contains null bytes/);
    });
  });

  describe('GenericStringSchema', () => {
    it('should accept strings up to 10 KB', () => {
      const validString = 'a'.repeat(PAYLOAD_LIMITS.GENERIC_STRING);
      expectSchemaAccepts(GenericStringSchema, validString);
    });

    it('should reject strings exceeding 10 KB', () => {
      const oversizedString = 'b'.repeat(PAYLOAD_LIMITS.GENERIC_STRING + 1);
      expectSchemaRejects(GenericStringSchema, oversizedString, /String exceeds maximum length/);
    });

    it('should reject strings with null bytes', () => {
      const stringWithNull = 'hello\0world';
      expectSchemaRejects(GenericStringSchema, stringWithNull, /String contains null bytes/);
    });
  });

  describe('Tool Parameter Schemas', () => {
    describe('SetWorkspaceParamsSchema', () => {
      it('should validate valid workspace params', () => {
        const validParams = {
          workspacePath: path.join('/', 'Users', 'test', 'my-project'),
          tsConfigPath: path.join('/', 'Users', 'test', 'my-project', 'tsconfig.json'),
          excludeNodeModules: true,
          maxDepth: 50,
        };

        expectSchemaAccepts(SetWorkspaceParamsSchema, validParams);
      });

      it('should reject oversized workspace path', () => {
        const invalidParams = {
          workspacePath: '/workspace/' + 'a'.repeat(PAYLOAD_LIMITS.FILE_PATH),
        };

        expectSchemaRejects(SetWorkspaceParamsSchema, invalidParams, /File path exceeds maximum length/);
      });
    });

    describe('AnalyzeBreakingChangesParamsSchema', () => {
      it('should validate valid breaking changes params', () => {
        const validParams = {
          filePath: path.join('/', 'Users', 'test', 'project', 'src', 'api.ts'),
          symbolName: 'myFunction',
          oldContent: 'export function myFunction(a: number) { return a; }',
          newContent: 'export function myFunction(a: number, b: number) { return a + b; }',
        };

        expectSchemaAccepts(AnalyzeBreakingChangesParamsSchema, validParams);
      });

      it('should reject oversized file content', () => {
        const invalidParams = {
          filePath: path.join('/', 'Users', 'test', 'project', 'src', 'api.ts'),
          oldContent: 'x'.repeat(PAYLOAD_LIMITS.FILE_CONTENT + 1),
        };

        expectSchemaRejects(
          AnalyzeBreakingChangesParamsSchema,
          invalidParams,
          /File content exceeds maximum size/
        );
      });

      it('should reject oversized symbol name', () => {
        const invalidParams = {
          filePath: path.join('/', 'Users', 'test', 'project', 'src', 'api.ts'),
          symbolName: 'a'.repeat(PAYLOAD_LIMITS.SYMBOL_NAME + 1),
          oldContent: 'export function test() {}',
        };

        expectSchemaRejects(
          AnalyzeBreakingChangesParamsSchema,
          invalidParams,
          /Symbol name exceeds maximum length/
        );
      });
    });

    describe('GetSymbolCallersParamsSchema', () => {
      it('should validate valid symbol callers params', () => {
        const validParams = {
          filePath: path.join('/', 'Users', 'test', 'project', 'src', 'utils.ts'),
          symbolName: 'calculateSum',
          includeTypeOnly: false,
        };

        expectSchemaAccepts(GetSymbolCallersParamsSchema, validParams);
      });

      it('should reject oversized file path', () => {
        const invalidParams = {
          filePath: '/path/' + 'a'.repeat(PAYLOAD_LIMITS.FILE_PATH),
          symbolName: 'test',
        };

        expectSchemaRejects(
          GetSymbolCallersParamsSchema,
          invalidParams,
          /File path exceeds maximum length/
        );
      });

      it('should reject oversized symbol name', () => {
        const invalidParams = {
          filePath: path.join('/', 'Users', 'test', 'project', 'src', 'utils.ts'),
          symbolName: 'b'.repeat(PAYLOAD_LIMITS.SYMBOL_NAME + 1),
        };

        expectSchemaRejects(
          GetSymbolCallersParamsSchema,
          invalidParams,
          /Symbol name exceeds maximum length/
        );
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle exactly at the limit', () => {
      const pathAtLimit = '/'.repeat(PAYLOAD_LIMITS.FILE_PATH);
      const symbolAtLimit = 'a'.repeat(PAYLOAD_LIMITS.SYMBOL_NAME);
      const contentAtLimit = 'x'.repeat(PAYLOAD_LIMITS.FILE_CONTENT);
      const stringAtLimit = 'y'.repeat(PAYLOAD_LIMITS.GENERIC_STRING);

      expectSchemaAccepts(FilePathSchema, pathAtLimit);
      expectSchemaAccepts(SymbolNameSchema, symbolAtLimit);
      expectSchemaAccepts(FileContentSchema, contentAtLimit);
      expectSchemaAccepts(GenericStringSchema, stringAtLimit);
    });

    it('should handle empty strings', () => {
      expectSchemaAccepts(FilePathSchema, '');
      expectSchemaAccepts(SymbolNameSchema, '');
      expectSchemaAccepts(FileContentSchema, '');
      expectSchemaAccepts(GenericStringSchema, '');
    });

    it('should handle unicode characters correctly', () => {
      const unicodePath = path.join('/', 'path', 'to', '文件', 'ファイル', '파일.ts');
      const unicodeSymbol = 'calculateΣ';
      const unicodeContent = '// 코멘트\nexport const π = 3.14;';
      
      expectSchemaAccepts(FilePathSchema, unicodePath);
      expectSchemaAccepts(SymbolNameSchema, unicodeSymbol);
      expectSchemaAccepts(FileContentSchema, unicodeContent);
    });
  });

  describe('Security: Null Byte Injection', () => {
    it('should prevent null byte injection in all schemas', () => {
      const nullByteTests = [
        { schema: FilePathSchema, value: path.join('/path', 'to', 'file\0.ts'), name: 'FilePathSchema' },
        { schema: SymbolNameSchema, value: 'func\0tion', name: 'SymbolNameSchema' },
        { schema: FileContentSchema, value: 'export\0const', name: 'FileContentSchema' },
        { schema: GenericStringSchema, value: 'hello\0world', name: 'GenericStringSchema' },
      ];

      nullByteTests.forEach(({ schema, value }) => {
        expectSchemaRejects(schema, value, /contains null bytes/);
      });
    });
  });
});
