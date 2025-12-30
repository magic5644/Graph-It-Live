# MCP Payload Size Limits

## Overview

Graph-It-Live MCP server implements **progressive payload size limits** to prevent memory exhaustion and potential DoS attacks while supporting legitimate use cases. All payloads are validated using Zod v4 schemas with built-in size constraints.

## Motivation

Without size limits, malicious or accidental payloads could cause:
- **Memory exhaustion**: Large file contents (e.g., minified bundles, binary files) consuming all available RAM
- **CPU overload**: Excessive validation/processing time
- **Service degradation**: Slow response times affecting other users/tools

## Implemented Limits

| Payload Type | Limit | Use Case Coverage |
|--------------|-------|-------------------|
| **File Paths** | 1 KB (~200 chars) | Covers deeply nested directory structures on all platforms |
| **Symbol Names** | 500 bytes | Covers reasonable function/class/method names |
| **File Content** | 1 MB (~40K lines) | Covers 99.9% of source files, rejects minified/binary files |
| **Generic Strings** | 10 KB | General purpose limit for module specifiers, etc. |

## Schema Architecture

### Reusable Schemas

All MCP tool parameter schemas use these building blocks:

```typescript
import {
  FilePathSchema,       // For file paths
  SymbolNameSchema,     // For function/class/method names
  FileContentSchema,    // For oldContent/newContent
  GenericStringSchema,  // For module specifiers, etc.
} from '@/mcp/types';
```

### Protected Tools

The following tools have payload protection:

#### File-Level Tools
- `set_workspace` - workspace paths, tsconfig paths
- `analyze_dependencies` - file paths
- `crawl_dependency_graph` - entry file paths
- `find_referencing_files` - target file paths
- `expand_node` - file paths and known paths arrays
- `parse_imports` - file paths
- `verify_dependency_usage` - source and target file paths
- `resolve_module_path` - file paths and module specifiers
- `invalidate_files` - file paths arrays

#### Symbol-Level Tools
- `get_symbol_graph` - file paths
- `find_unused_symbols` - file paths
- `get_symbol_dependents` - file paths and symbol names
- `trace_function_execution` - file paths and symbol names
- `get_symbol_callers` - file paths and symbol names
- `get_impact_analysis` - file paths and symbol names

#### Breaking Changes Analysis
- `analyze_breaking_changes` - file paths, symbol names, **and file content** (oldContent/newContent)

## Error Handling

When a payload exceeds the limit, Zod validation returns a clear error:

```json
{
  "error": "File content exceeds maximum size of 1048576 bytes (~1 MB)",
  "code": "VALIDATION_ERROR"
}
```

### Example: Oversized File Content

```typescript
// ❌ This will be rejected
const result = await analyzeBreakingChanges({
  filePath: '/path/to/file.ts',
  oldContent: 'x'.repeat(2 * 1024 * 1024), // 2 MB - exceeds 1 MB limit
});

// ✅ This will succeed
const result = await analyzeBreakingChanges({
  filePath: '/path/to/file.ts',
  oldContent: fs.readFileSync('normal-file.ts', 'utf-8'), // Typical source file
});
```

## Security Features

### Null Byte Protection

All string schemas reject null bytes (`\0`) to prevent:
- Path traversal attacks
- SQL injection (if paths are logged to databases)
- String termination exploits

```typescript
// ❌ Rejected
FilePathSchema.parse('/path/to/file\0.ts'); 
// Error: "File path contains null bytes"
```

### Unicode Support

The limits are **byte-based** (not character-based) and correctly handle multi-byte Unicode characters:

```typescript
// ✅ Accepted - Unicode is properly handled
FilePathSchema.parse('/path/文件/ファイル/파일.ts');
SymbolNameSchema.parse('calculateΣ');
```

## Testing

Comprehensive test suite in `tests/mcp/payloadLimits.test.ts`:

```bash
npm test -- payloadLimits
```

Tests cover:
- ✅ Valid payloads within limits
- ✅ Rejection of oversized payloads
- ✅ Null byte injection prevention
- ✅ Edge cases (exactly at limit, empty strings)
- ✅ Unicode handling
- ✅ Integration with tool parameter schemas

## Design Rationale

### Why These Specific Limits?

1. **File Paths (1 KB)**: 
   - Typical max path: 260 chars (Windows), 4096 bytes (Linux)
   - 1 KB accommodates deeply nested structures without accepting malicious payloads

2. **Symbol Names (500 bytes)**:
   - Longest reasonable identifier in real codebases: ~100 chars
   - 500 bytes provides generous headroom for edge cases

3. **File Content (1 MB)**:
   - Average source file: 5-50 KB
   - 95th percentile: ~200 KB
   - 1 MB catches legitimate large files while rejecting minified bundles (often 5-50 MB)

4. **Generic Strings (10 KB)**:
   - Module specifiers: typically <100 chars
   - 10 KB provides room for complex specifiers without accepting abuse

### Why Progressive Limits?

Different payload types have different size expectations:
- **Paths** should be short (file system constraints)
- **Symbols** should be readable (developer constraints)
- **Content** can be large (legitimate source files)

A single global limit would be either:
- Too restrictive (reject valid large files)
- Too permissive (allow path/symbol abuse)

## Migration Guide

### Existing Code

No changes required! All existing valid payloads remain accepted.

### Adding New Tools

Use the reusable schemas:

```typescript
// ❌ DON'T: Use raw z.string()
export const MyToolParamsSchema = z.object({
  filePath: z.string(),  // No size validation!
});

// ✅ DO: Use validated schemas
export const MyToolParamsSchema = z.object({
  filePath: FilePathSchema,  // Built-in size + null byte protection
});
```

## Performance Impact

- **Validation overhead**: <1ms per payload (Zod is highly optimized)
- **Memory savings**: Prevents gigabyte-scale allocations
- **CPU savings**: Avoids processing malicious/accidental large payloads

## Future Enhancements

Potential improvements:
1. **Rate limiting**: Per-tool call limits to prevent rapid-fire abuse
2. **Dynamic limits**: Adjust based on available system memory
3. **Streaming validation**: For very large files, validate in chunks
4. **Metrics**: Track payload size distributions for tuning limits

## References

- [Zod v4 Documentation](https://zod.dev/)
- [OWASP: Input Validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Node.js Buffer Limits](https://nodejs.org/api/buffer.html#buffer_buffer_constants_max_length)
