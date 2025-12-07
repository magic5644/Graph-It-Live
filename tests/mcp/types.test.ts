/**
 * MCP Types Unit Tests
 *
 * Tests for the MCP type definitions, Zod schemas, and response helper functions.
 */

import { describe, it, expect } from 'vitest';
import {
  createSuccessResponse,
  createErrorResponse,
  enrichDependency,
  getRelativePath,
  MCP_TOOL_VERSION,
  AnalyzeDependenciesParamsSchema,
  CrawlDependencyGraphParamsSchema,
  FindReferencingFilesParamsSchema,
  ExpandNodeParamsSchema,
  ParseImportsParamsSchema,
  ResolveModulePathParamsSchema,
  GetIndexStatusParamsSchema,
  GetSymbolGraphParamsSchema,
  FindUnusedSymbolsParamsSchema,
  GetSymbolDependentsParamsSchema,
  TraceFunctionExecutionParamsSchema,
  InvalidateFilesParamsSchema,
  RebuildIndexParamsSchema,
} from '../../src/mcp/types';
import type { Dependency } from '../../src/analyzer/types';

// ============================================================================
// Response Helper Tests
// ============================================================================

describe('createSuccessResponse', () => {
  it('creates a success response with correct metadata', () => {
    const data = { count: 42, items: ['a', 'b'] };
    const response = createSuccessResponse(data, 150, '/workspace');

    expect(response.success).toBe(true);
    expect(response.data).toEqual(data);
    expect(response.metadata.executionTimeMs).toBe(150);
    expect(response.metadata.toolVersion).toBe(MCP_TOOL_VERSION);
    expect(response.metadata.workspaceRoot).toBe('/workspace');
    expect(response.metadata.timestamp).toBeDefined();
    expect(new Date(response.metadata.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('includes pagination info when provided', () => {
    const data = { items: [1, 2, 3] };
    const pagination = { total: 100, limit: 10, offset: 20, hasMore: true };
    const response = createSuccessResponse(data, 50, '/workspace', pagination);

    expect(response.pagination).toEqual(pagination);
  });

  it('omits pagination when not provided', () => {
    const response = createSuccessResponse({ foo: 'bar' }, 10, '/workspace');

    expect(response.pagination).toBeUndefined();
  });
});

describe('createErrorResponse', () => {
  it('creates an error response with correct metadata', () => {
    const response = createErrorResponse<string>('Something went wrong', 25, '/workspace');

    expect(response.success).toBe(false);
    expect(response.error).toBe('Something went wrong');
    expect(response.data).toBeNull();
    expect(response.metadata.executionTimeMs).toBe(25);
    expect(response.metadata.toolVersion).toBe(MCP_TOOL_VERSION);
    expect(response.metadata.workspaceRoot).toBe('/workspace');
  });
});

// ============================================================================
// enrichDependency Tests
// ============================================================================

describe('enrichDependency', () => {
  const workspaceRoot = '/project';

  it('enriches a dependency with relative path inside workspace', () => {
    const dep: Dependency = {
      path: '/project/src/utils/helper.ts',
      type: 'import',
      line: 5,
      module: './utils/helper',
    };
    const result = enrichDependency(dep, workspaceRoot);

    expect(result.path).toBe('/project/src/utils/helper.ts');
    expect(result.relativePath).toBe('src/utils/helper.ts');
    expect(result.type).toBe('import');
    expect(result.line).toBe(5);
    expect(result.module).toBe('./utils/helper');
    expect(result.extension).toBe('ts');
  });

  it('handles paths outside workspace', () => {
    const dep: Dependency = {
      path: '/other/sibling/file.ts',
      type: 'require',
      line: 10,
      module: '../sibling/file',
    };
    const result = enrichDependency(dep, workspaceRoot);

    expect(result.path).toBe('/other/sibling/file.ts');
    expect(result.relativePath).toBe('/other/sibling/file.ts');
    expect(result.type).toBe('require');
  });

  it('handles dynamic imports', () => {
    const dep: Dependency = {
      path: '/project/src/lazy.ts',
      type: 'dynamic',
      line: 20,
      module: './lazy',
    };
    const result = enrichDependency(dep, workspaceRoot);

    expect(result.type).toBe('dynamic');
  });

  it('handles export re-exports', () => {
    const dep: Dependency = {
      path: '/project/src/types.ts',
      type: 'export',
      line: 1,
      module: './types',
    };
    const result = enrichDependency(dep, workspaceRoot);

    expect(result.type).toBe('export');
  });
});

// ============================================================================
// getRelativePath Tests
// ============================================================================

describe('getRelativePath', () => {
  it('returns relative path for file inside workspace', () => {
    const result = getRelativePath('/project/src/file.ts', '/project');
    expect(result).toBe('src/file.ts');
  });

  it('returns full path for file outside workspace', () => {
    const result = getRelativePath('/other/file.ts', '/project');
    expect(result).toBe('/other/file.ts');
  });
});

// ============================================================================
// Zod Schema Validation Tests
// ============================================================================

describe('AnalyzeDependenciesParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = AnalyzeDependenciesParamsSchema.safeParse({
      filePath: '/project/src/index.ts',
    });

    expect(result.success).toBe(true);
    expect(result.data?.filePath).toBe('/project/src/index.ts');
  });

  it('accepts empty filePath (no min constraint)', () => {
    const result = AnalyzeDependenciesParamsSchema.safeParse({
      filePath: '',
    });

    // No min(1) constraint in current schema
    expect(result.success).toBe(true);
  });

  it('rejects missing filePath', () => {
    const result = AnalyzeDependenciesParamsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('CrawlDependencyGraphParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = CrawlDependencyGraphParamsSchema.safeParse({
      entryFile: '/project/src/main.ts',
    });

    expect(result.success).toBe(true);
    expect(result.data?.entryFile).toBe('/project/src/main.ts');
  });

  it('validates with all optional parameters', () => {
    const result = CrawlDependencyGraphParamsSchema.safeParse({
      entryFile: '/project/src/main.ts',
      maxDepth: 5,
      limit: 100,
      offset: 20,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBe(5);
      expect(result.data.limit).toBe(100);
      expect(result.data.offset).toBe(20);
    }
  });

  it('accepts without maxDepth (optional field)', () => {
    const result = CrawlDependencyGraphParamsSchema.safeParse({
      entryFile: '/project/src/main.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBeUndefined();
    }
  });

  it('accepts negative limit (no min constraint)', () => {
    const result = CrawlDependencyGraphParamsSchema.safeParse({
      entryFile: '/project/src/main.ts',
      limit: -1,
    });

    // No min constraint in current schema
    expect(result.success).toBe(true);
  });

  it('accepts negative offset (no min constraint)', () => {
    const result = CrawlDependencyGraphParamsSchema.safeParse({
      entryFile: '/project/src/main.ts',
      offset: -5,
    });

    // No min constraint in current schema
    expect(result.success).toBe(true);
  });
});

describe('FindReferencingFilesParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = FindReferencingFilesParamsSchema.safeParse({
      targetPath: '/project/src/utils.ts',
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing targetPath', () => {
    const result = FindReferencingFilesParamsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('ExpandNodeParamsSchema', () => {
  it('validates with knownPaths', () => {
    const result = ExpandNodeParamsSchema.safeParse({
      filePath: '/project/src/component.ts',
      knownPaths: ['/project/src/index.ts', '/project/src/utils.ts'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knownPaths).toHaveLength(2);
    }
  });

  it('rejects without required knownPaths', () => {
    const result = ExpandNodeParamsSchema.safeParse({
      filePath: '/project/src/component.ts',
    });

    // knownPaths is required in the schema
    expect(result.success).toBe(false);
  });
});

describe('ParseImportsParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = ParseImportsParamsSchema.safeParse({
      filePath: '/project/src/file.vue',
    });

    expect(result.success).toBe(true);
  });
});

describe('ResolveModulePathParamsSchema', () => {
  it('validates required parameters', () => {
    const result = ResolveModulePathParamsSchema.safeParse({
      moduleSpecifier: '@/components/Button',
      fromFile: '/project/src/App.vue',
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing moduleSpecifier', () => {
    const result = ResolveModulePathParamsSchema.safeParse({
      fromFile: '/project/src/App.vue',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing fromFile', () => {
    const result = ResolveModulePathParamsSchema.safeParse({
      moduleSpecifier: '@/components/Button',
    });

    expect(result.success).toBe(false);
  });
});

describe('GetIndexStatusParamsSchema', () => {
  it('accepts empty object', () => {
    const result = GetIndexStatusParamsSchema.safeParse({});

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// MCP_TOOL_VERSION Tests
// ============================================================================

describe('MCP_TOOL_VERSION', () => {
  it('is a valid semver string', () => {
    expect(MCP_TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ============================================================================
// Symbol Analysis Params Schema Tests
// ============================================================================

describe('GetSymbolGraphParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = GetSymbolGraphParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
    });

    expect(result.success).toBe(true);
    expect(result.data?.filePath).toBe('/project/src/service.ts');
  });

  it('rejects missing filePath', () => {
    const result = GetSymbolGraphParamsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('FindUnusedSymbolsParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = FindUnusedSymbolsParamsSchema.safeParse({
      filePath: '/project/src/utils.ts',
    });

    expect(result.success).toBe(true);
  });
});

describe('GetSymbolDependentsParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = GetSymbolDependentsParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
      symbolName: 'getUserById',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/service.ts');
      expect(result.data.symbolName).toBe('getUserById');
    }
  });

  it('rejects missing symbolName', () => {
    const result = GetSymbolDependentsParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing filePath', () => {
    const result = GetSymbolDependentsParamsSchema.safeParse({
      symbolName: 'getUserById',
    });

    expect(result.success).toBe(false);
  });
});

describe('TraceFunctionExecutionParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = TraceFunctionExecutionParamsSchema.safeParse({
      filePath: '/project/src/controller.ts',
      symbolName: 'handleRequest',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/controller.ts');
      expect(result.data.symbolName).toBe('handleRequest');
      expect(result.data.maxDepth).toBeUndefined();
    }
  });

  it('validates with maxDepth', () => {
    const result = TraceFunctionExecutionParamsSchema.safeParse({
      filePath: '/project/src/controller.ts',
      symbolName: 'handleRequest',
      maxDepth: 20,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDepth).toBe(20);
    }
  });

  it('rejects missing symbolName', () => {
    const result = TraceFunctionExecutionParamsSchema.safeParse({
      filePath: '/project/src/controller.ts',
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-number maxDepth', () => {
    const result = TraceFunctionExecutionParamsSchema.safeParse({
      filePath: '/project/src/controller.ts',
      symbolName: 'handleRequest',
      maxDepth: 'deep',
    });

    expect(result.success).toBe(false);
  });
});

describe('InvalidateFilesParamsSchema', () => {
  it('validates valid parameters', () => {
    const result = InvalidateFilesParamsSchema.safeParse({
      filePaths: ['/project/src/file1.ts', '/project/src/file2.ts'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePaths).toHaveLength(2);
    }
  });

  it('accepts empty array', () => {
    const result = InvalidateFilesParamsSchema.safeParse({
      filePaths: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing filePaths', () => {
    const result = InvalidateFilesParamsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('RebuildIndexParamsSchema', () => {
  it('accepts empty object', () => {
    const result = RebuildIndexParamsSchema.safeParse({});

    expect(result.success).toBe(true);
  });
});
