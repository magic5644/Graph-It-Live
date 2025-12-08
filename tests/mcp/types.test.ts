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
  SetWorkspaceParamsSchema,
  GetSymbolCallersParamsSchema,
  AnalyzeBreakingChangesParamsSchema,
  GetImpactAnalysisParamsSchema,
  validateToolParams,
  validateFilePath,
  sanitizeString,
  normalizePathForComparison,
  isPathWithinRoot,
} from '../../src/mcp/types';
import type { Dependency } from '../../src/analyzer/types';
import type { McpWorkerResponse } from '../../src/mcp/types';

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

  // Windows-specific test - only meaningful on Windows
  it.skipIf(process.platform !== 'win32')('handles Windows-style paths', () => {
    const dep: Dependency = {
      path: String.raw`C:\project\src\utils\helper.ts`,
      type: 'import',
      line: 5,
      module: './utils/helper',
    };
    const result = enrichDependency(dep, String.raw`C:\project`);

    expect(result.relativePath).toBe('src/utils/helper.ts');
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

  // Windows-specific tests - only meaningful on Windows
  it.skipIf(process.platform !== 'win32')('handles Windows paths with drive letters', () => {
    const result = getRelativePath(String.raw`C:\project\src\file.ts`, String.raw`C:\project`);
    expect(result).toBe('src/file.ts');
  });

  it.skipIf(process.platform !== 'win32')('returns full path when on different Windows drives', () => {
    const result = getRelativePath(String.raw`D:\other\file.ts`, String.raw`C:\project`);
    // On different drives, path.relative returns absolute path
    expect(result).toBe(String.raw`D:\other\file.ts`);
  });

  it.skipIf(process.platform !== 'win32')('normalizes backslashes to forward slashes in output', () => {
    const result = getRelativePath(String.raw`C:\project\src\deep\nested\file.ts`, String.raw`C:\project`);
    expect(result).toBe('src/deep/nested/file.ts');
    expect(result).not.toContain('\\');
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

// ============================================================================
// New Schema Validation Tests for v1.x tools
// ============================================================================

describe('SetWorkspaceParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = SetWorkspaceParamsSchema.safeParse({
      workspacePath: '/project/my-app',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspacePath).toBe('/project/my-app');
    }
  });

  it('validates with all optional parameters', () => {
    const result = SetWorkspaceParamsSchema.safeParse({
      workspacePath: '/project/my-app',
      tsConfigPath: '/project/my-app/tsconfig.json',
      excludeNodeModules: false,
      maxDepth: 100,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tsConfigPath).toBe('/project/my-app/tsconfig.json');
      expect(result.data.excludeNodeModules).toBe(false);
      expect(result.data.maxDepth).toBe(100);
    }
  });

  it('rejects missing workspacePath', () => {
    const result = SetWorkspaceParamsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('GetSymbolCallersParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = GetSymbolCallersParamsSchema.safeParse({
      filePath: '/project/src/utils.ts',
      symbolName: 'formatDate',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/utils.ts');
      expect(result.data.symbolName).toBe('formatDate');
      expect(result.data.includeTypeOnly).toBeUndefined();
    }
  });

  it('validates with includeTypeOnly=false', () => {
    const result = GetSymbolCallersParamsSchema.safeParse({
      filePath: '/project/src/utils.ts',
      symbolName: 'formatDate',
      includeTypeOnly: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeTypeOnly).toBe(false);
    }
  });

  it('rejects missing symbolName', () => {
    const result = GetSymbolCallersParamsSchema.safeParse({
      filePath: '/project/src/utils.ts',
    });

    expect(result.success).toBe(false);
  });
});

describe('AnalyzeBreakingChangesParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = AnalyzeBreakingChangesParamsSchema.safeParse({
      filePath: '/project/src/api.ts',
      oldContent: 'function foo(a: string) {}',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/api.ts');
      expect(result.data.oldContent).toBe('function foo(a: string) {}');
      expect(result.data.symbolName).toBeUndefined();
      expect(result.data.newContent).toBeUndefined();
    }
  });

  it('validates with all optional parameters', () => {
    const result = AnalyzeBreakingChangesParamsSchema.safeParse({
      filePath: '/project/src/api.ts',
      symbolName: 'foo',
      oldContent: 'function foo(a: string) {}',
      newContent: 'function foo(a: string, b: number) {}',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.symbolName).toBe('foo');
      expect(result.data.newContent).toBe('function foo(a: string, b: number) {}');
    }
  });

  it('rejects missing oldContent', () => {
    const result = AnalyzeBreakingChangesParamsSchema.safeParse({
      filePath: '/project/src/api.ts',
    });

    expect(result.success).toBe(false);
  });
});

describe('GetImpactAnalysisParamsSchema', () => {
  it('validates minimal parameters', () => {
    const result = GetImpactAnalysisParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
      symbolName: 'getUserById',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/service.ts');
      expect(result.data.symbolName).toBe('getUserById');
      expect(result.data.includeTransitive).toBeUndefined();
      expect(result.data.maxDepth).toBeUndefined();
    }
  });

  it('validates with all optional parameters', () => {
    const result = GetImpactAnalysisParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
      symbolName: 'getUserById',
      includeTransitive: true,
      maxDepth: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeTransitive).toBe(true);
      expect(result.data.maxDepth).toBe(10);
    }
  });

  it('rejects missing symbolName', () => {
    const result = GetImpactAnalysisParamsSchema.safeParse({
      filePath: '/project/src/service.ts',
    });

    expect(result.success).toBe(false);
  });
});

// ============================================================================
// McpWorkerResponse Type Tests
// ============================================================================

describe('McpWorkerResponse type', () => {
  it('should support file-invalidated message type', () => {
    const response: McpWorkerResponse = {
      type: 'file-invalidated',
      filePath: '/project/src/utils.ts',
      event: 'change',
    };

    expect(response.type).toBe('file-invalidated');
    expect(response.filePath).toBe('/project/src/utils.ts');
    expect(response.event).toBe('change');
  });

  it('should support all event types for file-invalidated', () => {
    const events: Array<'change' | 'add' | 'unlink'> = ['change', 'add', 'unlink'];
    
    for (const event of events) {
      const response: McpWorkerResponse = {
        type: 'file-invalidated',
        filePath: '/project/src/file.ts',
        event,
      };
      expect(response.event).toBe(event);
    }
  });

  it('should support ready message type', () => {
    const response: McpWorkerResponse = {
      type: 'ready',
      warmupDuration: 1000,
      indexedFiles: 50,
    };

    expect(response.type).toBe('ready');
  });

  it('should support warmup-progress message type', () => {
    const response: McpWorkerResponse = {
      type: 'warmup-progress',
      processed: 25,
      total: 100,
      currentFile: 'src/index.ts',
    };

    expect(response.type).toBe('warmup-progress');
  });
});

// ============================================================================
// Validation Functions Tests
// ============================================================================

describe('validateToolParams', () => {
  it('validates correct analyze_dependencies params', () => {
    const result = validateToolParams('analyze_dependencies', {
      filePath: '/project/src/index.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filePath).toBe('/project/src/index.ts');
    }
  });

  it('validates crawl_dependency_graph params with options', () => {
    const result = validateToolParams('crawl_dependency_graph', {
      entryFile: '/project/src/main.ts',
      maxDepth: 5,
      limit: 100,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryFile).toBe('/project/src/main.ts');
      expect(result.data.maxDepth).toBe(5);
      expect(result.data.limit).toBe(100);
    }
  });

  it('returns error for missing required fields', () => {
    const result = validateToolParams('analyze_dependencies', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('filePath');
  });

  it('returns error for wrong field types', () => {
    const result = validateToolParams('crawl_dependency_graph', {
      entryFile: '/project/src/main.ts',
      maxDepth: 'not-a-number',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('maxDepth');
  });

  it('validates get_index_status with empty params', () => {
    const result = validateToolParams('get_index_status', {});

    expect(result.success).toBe(true);
  });

  it('validates find_referencing_files params', () => {
    const result = validateToolParams('find_referencing_files', {
      targetPath: '/project/src/utils.ts',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetPath).toBe('/project/src/utils.ts');
    }
  });

  it('validates get_symbol_graph params', () => {
    const result = validateToolParams('get_symbol_graph', {
      filePath: '/project/src/api.ts',
    });

    expect(result.success).toBe(true);
  });

  it('validates trace_function_execution params', () => {
    const result = validateToolParams('trace_function_execution', {
      filePath: '/project/src/service.ts',
      symbolName: 'processData',
      maxDepth: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.symbolName).toBe('processData');
    }
  });
});

// ============================================================================
// Cross-Platform Path Utilities Tests
// ============================================================================

describe('normalizePathForComparison', () => {
  it('converts backslashes to forward slashes', () => {
    const result = normalizePathForComparison(String.raw`C:\project\src\file.ts`);
    expect(result).toBe('c:/project/src/file.ts');
  });

  it('lowercases Windows drive letters', () => {
    const result = normalizePathForComparison('D:/Project/Src');
    expect(result).toBe('d:/Project/Src');
  });

  it('removes trailing slashes', () => {
    expect(normalizePathForComparison('/project/')).toBe('/project');
    expect(normalizePathForComparison('C:/project/')).toBe('c:/project');
  });

  it('preserves root path slash', () => {
    expect(normalizePathForComparison('/')).toBe('/');
  });

  it('preserves Windows drive root', () => {
    expect(normalizePathForComparison('C:/')).toBe('c:/');
  });

  it('handles Unix paths unchanged (except trailing slash)', () => {
    expect(normalizePathForComparison('/home/user/project')).toBe('/home/user/project');
  });
});

describe('isPathWithinRoot', () => {
  it('returns true for path inside root (Unix)', () => {
    expect(isPathWithinRoot('/project/src/file.ts', '/project')).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('returns true for path inside root (Windows)', () => {
    expect(isPathWithinRoot(String.raw`C:\project\src\file.ts`, String.raw`C:\project`)).toBe(true);
  });

  it('returns false for path outside root', () => {
    expect(isPathWithinRoot('/other/file.ts', '/project')).toBe(false);
  });

  it('returns false for path with .. that escapes root', () => {
    expect(isPathWithinRoot('/project/../etc/passwd', '/project')).toBe(false);
  });

  it('returns true for path with .. that stays within root', () => {
    expect(isPathWithinRoot('/project/src/../utils/file.ts', '/project')).toBe(true);
  });

  it('returns true for root path itself', () => {
    expect(isPathWithinRoot('/project', '/project')).toBe(true);
  });

  it('returns false for similar-prefix path (not a subdirectory)', () => {
    // /project-other is NOT inside /project
    expect(isPathWithinRoot('/project-other/file.ts', '/project')).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('handles different Windows drives', () => {
    expect(isPathWithinRoot(String.raw`D:\other\file.ts`, String.raw`C:\project`)).toBe(false);
  });
});

describe('validateFilePath', () => {
  const rootDir = '/project';

  it('accepts valid path inside workspace', () => {
    // Should not throw
    expect(() => validateFilePath('/project/src/index.ts', rootDir)).not.toThrow();
  });

  it('accepts deeply nested path inside workspace', () => {
    expect(() => validateFilePath('/project/src/deep/nested/file.ts', rootDir)).not.toThrow();
  });

  it('rejects path traversal attempts with ..', () => {
    expect(() => validateFilePath('/project/../etc/passwd', rootDir)).toThrow('outside workspace');
  });

  it('rejects path outside workspace', () => {
    expect(() => validateFilePath('/other/project/file.ts', rootDir)).toThrow('outside workspace');
  });

  it('rejects absolute path to system directory', () => {
    expect(() => validateFilePath('/etc/passwd', rootDir)).toThrow('outside workspace');
  });

  it('rejects relative path attempting traversal', () => {
    expect(() => validateFilePath('../../etc/passwd', rootDir)).toThrow('outside workspace');
  });

  it('handles path traversal with ../', () => {
    expect(() => validateFilePath('/project/../etc/passwd', rootDir)).toThrow('outside workspace');
  });

  // Windows-specific tests - only run on Windows
  // On other platforms, path.resolve doesn't understand Windows paths
  it.skipIf(process.platform !== 'win32')('accepts Windows paths inside workspace', () => {
    const winRoot = String.raw`C:\project`;
    expect(() => validateFilePath(String.raw`C:\project\src\file.ts`, winRoot)).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows paths outside workspace', () => {
    const winRoot = String.raw`C:\project`;
    expect(() => validateFilePath(String.raw`D:\other\file.ts`, winRoot)).toThrow('outside workspace');
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows path traversal', () => {
    const winRoot = String.raw`C:\project`;
    expect(() => validateFilePath(String.raw`C:\project\..\Windows\System32\config`, winRoot)).toThrow('outside workspace');
  });
});

describe('sanitizeString', () => {
  it('returns string unchanged (without null bytes)', () => {
    expect(sanitizeString('hello world')).toBe('hello world');
  });

  it('throws TypeError for non-string input (number)', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString(42)).toThrow(TypeError);
  });

  it('throws TypeError for non-string input (boolean)', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString(true)).toThrow(TypeError);
  });

  it('throws TypeError for null', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString(null)).toThrow(TypeError);
  });

  it('throws TypeError for undefined', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString(undefined)).toThrow(TypeError);
  });

  it('throws TypeError for object', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString({ a: 1 })).toThrow(TypeError);
  });

  it('throws TypeError for array', () => {
    // @ts-expect-error Testing runtime validation
    expect(() => sanitizeString([1, 2, 3])).toThrow(TypeError);
  });

  it('preserves whitespace', () => {
    expect(sanitizeString('  hello  ')).toBe('  hello  ');
  });

  it('removes null characters', () => {
    expect(sanitizeString('hello\x00world')).toBe('helloworld');
  });

  it('throws error when input exceeds max length', () => {
    const longString = 'a'.repeat(10001);
    expect(() => sanitizeString(longString)).toThrow('exceeds maximum length');
  });

  it('respects custom max length', () => {
    const mediumString = 'a'.repeat(100);
    expect(() => sanitizeString(mediumString, 50)).toThrow('exceeds maximum length');
  });
});