# TOON Format Documentation

## Token-Oriented Object Notation (TOON)

### Overview

TOON (Token-Oriented Object Notation) is a compact serialization format designed to drastically reduce token consumption when analyzing code with LLMs. It's particularly effective for large structured datasets like dependency graphs, symbol lists, and file analysis results.

### Format Specification

#### Structure

TOON consists of two parts:

1. **Header**: Defines the object name and field names
   ```
   objectName(field1,field2,field3)
   ```

2. **Data Lines**: One line per object, with values in brackets
   ```
   [value1,value2,value3]
   ```

#### Example

**JSON (Original)**:
```json
[
  { "file": "main.ts", "deps": ["fs", "path"], "line": 10 },
  { "file": "utils.ts", "deps": ["os", "crypto"], "line": 20 }
]
```

**TOON (Compact)**:
```
files(file,deps,line)
[main.ts,fs|path,10]
[utils.ts,os|crypto,20]
```

### Features

#### 1. Array Serialization

Arrays within values are joined with pipe `|` delimiter:
- `["fs", "path"]` → `fs|path`
- `["a", "b", "c"]` → `a|b|c`

#### 2. Escaping

Special characters are escaped when `escapeValues: true` (default):
- Comma: `,` → `\,`
- Pipe: `|` → `\|`
- Brackets: `[` → `\[`, `]` → `\]`
- Backslash: `\` → `\\`

#### 3. Type Preservation

TOON automatically handles:
- **Numbers**: `42`, `3.14`, `-5`
- **Booleans**: `true`, `false`
- **Strings**: Any text
- **Arrays**: Multi-value fields with pipe delimiter
- **Objects**: Serialized as JSON strings
- **Empty values**: Empty string `''`

### Token Savings

TOON can save **30-60%** tokens compared to JSON for structured data:

| Format | Tokens | Size |
|--------|--------|------|
| JSON (formatted) | ~100 | ~500 bytes |
| JSON (minified) | ~80 | ~300 bytes |
| TOON | ~40 | ~200 bytes |

### Usage in MCP Server

#### Request Format Parameter

All MCP tools now accept a `format` parameter:

```json
{
  "tool": "crawl_dependency_graph",
  "params": {
    "entryFile": "/path/to/main.ts",
    "format": "toon"
  }
}
```

**Available formats**:
- `json` (default): Standard JSON output
- `toon`: Compact TOON format
- `markdown`: JSON wrapped in markdown code blocks

#### Automatic Format Suggestion

The server automatically suggests TOON format for large datasets (>10 items).

#### Token Savings Metadata

When using TOON format, responses include token savings information:

```
files(file,deps,line)
[main.ts,fs|path,10]
[utils.ts,os|crypto,20]

# Token Savings
JSON: 125 tokens
TOON: 48 tokens
Savings: 77 tokens (61.6%)
```

### API Reference

#### jsonToToon(data, options)

Converts JSON array to TOON format.

**Parameters**:
- `data: unknown[]` - Array of objects to convert
- `options?: ToonOptions`
  - `objectName?: string` - Name for the object type (default: 'data')
  - `escapeValues?: boolean` - Whether to escape special characters (default: true)

**Returns**: `string` - TOON formatted string

**Example**:
```typescript
import { jsonToToon } from '@/shared/toon';

const data = [
  { file: 'main.ts', line: 10 },
  { file: 'utils.ts', line: 20 },
];

const toon = jsonToToon(data, { objectName: 'files' });
// Result: "files(file,line)\n[main.ts,10]\n[utils.ts,20]"
```

#### toonToJson(toonStr, options)

Parses TOON format back to JSON array.

**Parameters**:
- `toonStr: string` - TOON formatted string
- `options?: ToonOptions` - Same as jsonToToon

**Returns**: `unknown[]` - Parsed array of objects

**Example**:
```typescript
import { toonToJson } from '@/shared/toon';

const toon = 'files(file,line)\n[main.ts,10]\n[utils.ts,20]';
const data = toonToJson(toon);
// Result: [{ file: 'main.ts', line: 10 }, { file: 'utils.ts', line: 20 }]
```

#### estimateTokenSavings(jsonStr, toonStr)

Estimates token savings between JSON and TOON formats.

**Parameters**:
- `jsonStr: string` - JSON formatted string
- `toonStr: string` - TOON formatted string

**Returns**: Object with:
- `jsonTokens: number` - Estimated tokens for JSON
- `toonTokens: number` - Estimated tokens for TOON
- `savings: number` - Token difference
- `savingsPercent: number` - Percentage saved

### Best Practices

#### When to Use TOON

✅ **Use TOON for**:
- Large arrays (>10 items)
- Structured data (dependencies, symbols, nodes)
- Repeated API calls with similar data
- Token-sensitive operations

❌ **Avoid TOON for**:
- Small datasets (<5 items)
- Highly nested structures
- One-off queries
- Human-readable output

#### Limitations

1. **Single-Element Arrays**: Arrays with one element (e.g., `["os"]`) are indistinguishable from strings after parsing. Use multi-element arrays for proper array detection.

2. **Nested Objects**: Complex nested objects are serialized as JSON strings within TOON, reducing efficiency.

3. **Type Loss**: Some type information may be lost in round-trip conversion (e.g., `null` becomes `''`).

### Integration Example

#### MCP Tool Handler

```typescript
import { formatDataAsToon } from '@/mcp/responseFormatter';

// In your tool handler
const result = await analyze(filePath);

// Format based on user preference
const formatted = params.format === 'toon'
  ? formatDataAsToon(result.dependencies, 'dependencies')
  : JSON.stringify(result, null, 2);

return { content: formatted };
```

#### Extension Usage

```typescript
import { jsonToToon, toonToJson } from '@/shared/toon';

// Send data in TOON format
const toon = jsonToToon(dependencies, { objectName: 'deps' });
await sendToMcp(toon);

// Receive and parse TOON data
const received = await receiveFromMcp();
const data = toonToJson(received);
```

### Testing

Comprehensive test suite available in:
- `tests/shared/toon.test.ts` - Core TOON functionality
- `tests/mcp/responseFormatter.test.ts` - Integration with MCP

Run tests:
```bash
npm test -- tests/shared/toon.test.ts
npm test -- tests/mcp/responseFormatter.test.ts
```

### Contributing

When modifying the TOON module:

1. Ensure cross-platform compatibility (Windows, Linux, macOS)
2. Add tests for new features
3. Update token savings benchmarks
4. Run security scan: `npm run snyk`
5. Verify types: `npm run check:types`
6. Lint: `npm run lint`

### Related Documentation

- [MCP Server Documentation](../docs/mcp-server.md)
- [Response Formatting](../src/mcp/responseFormatter.ts)
- [Shared Utilities](../src/shared/README.md)
