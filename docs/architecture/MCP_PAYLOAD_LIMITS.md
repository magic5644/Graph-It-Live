# MCP Payload Size Limits

## Overview

Graph-It-Live MCP server implements **progressive payload size limits** to prevent memory exhaustion and potential DoS attacks while supporting legitimate use cases. All payloads are validated using Zod v4 schemas with built-in size constraints.

## Motivation

Without size limits, malicious or accidental payloads could cause:
- **Memory exhaustion**: Large file contents (e.g., minified bundles, binary files) consuming all available RAM
- **CPU overload**: Excessive validation/processing time
- **Service degradation**: Slow response times affecting other users/tools

## Implemented Limits

Zod's string limits use JavaScript string length (UTF-16 code units), even
where legacy validation messages say "bytes."

| Payload Type | Limit | Use Case Coverage |
|--------------|-------|-------------------|
| **File paths** | 1,024 code units | Deep workspace paths |
| **Symbol names** | 500 code units | Function, class, and method names |
| **File content** | 1,048,576 code units | Large source files; minified or binary input may still be rejected elsewhere |
| **Generic strings** | 10,240 code units | Module specifiers, labels, and stable IDs |

### Graph context request limits

The `graphitlive_graph_context` request has additional bounded fields:

| Field | Limit | Default |
|-------|-------|---------|
| `question` | 1,024 characters | — |
| `seeds` | 500 entries | — |
| each seed or endpoint `id` / `label` | 10,240 code units | — |
| each seed or endpoint `filePath` | 1,024 code units | — |
| each seed or endpoint `symbolName` | 500 code units | — |
| `relations` | 12 unique entries | all |
| `scope` | 256 characters | workspace (`**`) |
| `depth` | integer 1–5 | 2 |
| `maxNodes` | integer 1–500, requested page bound | 200 |
| `tokenBudget` | integer 500–16,000 | 4,000 |
| `cursor` | 4,096 URL-safe base64 characters | — |
| `response_format` (MCP envelope) | `json`, `markdown`, or `toon` | `toon` |

Seeds, endpoints, and scope paths are validated against the configured
workspace. Paths outside it are rejected. An ambiguous entity is returned as
candidates rather than silently selected; an unresolved external call is
retained as an `external:` node, with `AMBIGUOUS` confidence when multiple
internal targets match. A stale or request-mismatched cursor is rejected and
must not be reused after the index revision changes. Unsupported language
constructs and unsupported languages remain absent from the local graph rather
than being synthesized. Graph context currently covers TypeScript, JavaScript,
Python, Rust, C#, Go, Java, Vue, Svelte, and GraphQL through the project's
language analyzers.
`maxNodes` is a requested page bound. Mandatory seeds and path endpoints are
preserved even when they make the response exceed that value. If those
mandatory nodes alone exceed the token budget, the request fails rather than
dropping them. Responses return graph evidence and line spans, not source
contents.

`from` and `to` must appear together and are valid only in `path` mode. A
request must contain a non-empty question, at least one seed, or both endpoints.

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
- `graph_context` - questions, seeds, endpoints, relations, scope, traversal,
  pagination, and representation bounds

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

Validated path, symbol, content, and generic-string schemas reject null bytes
(`\0`) to prevent:
- Path traversal attacks
- SQL injection (if paths are logged to databases)
- String termination exploits

```typescript
// ❌ Rejected
FilePathSchema.parse('/path/to/file\0.ts'); 
// Error: "File path contains null bytes"
```

### Unicode Support

Unicode values are accepted, but limits count JavaScript UTF-16 code units,
not UTF-8 bytes or user-perceived characters:

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

1. **File paths (1,024 code units)**:
   - Accommodates deeply nested workspace paths without accepting unbounded input

2. **Symbol names (500 code units)**:
   - Longest reasonable identifier in real codebases: ~100 chars
   - 500 code units provide generous headroom for edge cases

3. **File content (1,048,576 code units)**:
   - Average source file: 5-50 KB
   - 95th percentile: ~200 KB
   - The limit admits large source files while rejecting unbounded content

4. **Generic strings (10,240 code units)**:
   - Module specifiers: typically <100 chars
   - 10,240 code units provide room for complex specifiers without accepting unbounded input

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

## Rate Limiting

`set_workspace`, `rebuild_index`, and `invalidate_files` trigger a full re-index or
bulk cache invalidation, and have no per-call payload cost cap. An in-memory
sliding-window limiter in `mcpServer.ts` (`checkRateLimit`) rejects excess calls
per tool within a 10s window (`set_workspace`/`rebuild_index`: 5 calls,
`invalidate_files`: 20 calls) to prevent a flood of distinct calls from
saturating CPU/IO even though each individual call is otherwise valid.

## Accepted Risk: `set_workspace` Has No Root Allowlist

`set_workspace` accepts any directory readable by the server process — there is
no allowlist restricting it to the original project root or a set of trusted
paths. This is intentional: the tool exists to let a client switch between
projects in the same session without friction.

**Residual risk**: a compromised or prompt-injected LLM client could call
`set_workspace` against a sensitive directory (e.g. `~/.ssh`, `~/.aws`) and then
use an analysis tool (`analyze_file_logic`, `generate_wiki`, `parse_imports`) to
read and surface file contents from that directory back to the model. The MCP
server has no sandbox beyond the OS-level permissions of the user running it.

**Decision**: accepted risk, documented rather than mitigated with an allowlist,
per product requirement to keep multi-project usage frictionless. Mitigation
lives at the client/agent trust boundary (do not point a client with untrusted
input at this server without reviewing what `set_workspace` calls it issues),
not in the MCP server itself. Revisit if a concrete exfiltration incident occurs.

## Future Enhancements

Potential improvements:
1. **Dynamic limits**: Adjust based on available system memory
2. **Streaming validation**: For very large files, validate in chunks
3. **Metrics**: Track payload size distributions for tuning limits

## References

- [Zod v4 Documentation](https://zod.dev/)
- [OWASP: Input Validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Node.js Buffer Limits](https://nodejs.org/api/buffer.html#buffer_buffer_constants_max_length)
