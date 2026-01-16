# MCP Tool Contract: graphItLive_analyzeFileLogic

**Tool Name**: `graphItLive_analyzeFileLogic`  
**Purpose**: Analyze symbol-level call hierarchy within a single file for AI/LLM consumption  
**Input Format**: JSON  
**Output Format**: TOON (Tree Object Oriented Notation) - compressed format for token efficiency

---

## Input Schema

```typescript
interface AnalyzeFileLogicRequest {
  filePath: string;           // Absolute path to file to analyze
  includeExternal?: boolean;  // Include calls to imported functions (default: false)
  format?: 'toon' | 'json';   // Output format (default: 'toon')
}
```

**Validation**:
- `filePath` must be absolute path within workspace
- `filePath` must exist and be readable
- `filePath` must have supported extension (.ts, .tsx, .js, .jsx, .py, .rs)
- `format` if provided must be 'toon' or 'json'

---

## Output Schema (TOON Format)

```
nodes:Class:ClassName|Function:functionName|Variable:varName
edges:functionName>targetFunc:calls:42|functionName~constantRef:references:15
cycles:func1>func2>func3>func1
external:importedFunc:someModule
```

**Format Breakdown**:
- **nodes**: Pipe-separated list of `Type:Name`
  - Types: `Class`, `Function`, `Variable`, `Method`
- **edges**: Pipe-separated list of `source>target:relation:line` (calls) or `source~target:relation:line` (references)
  - `>` = calls, `~` = references
  - `relation`: 'calls' or 'references'
  - `line`: line number where call occurs
- **cycles**: Pipe-separated circular paths `a>b>c>a`
- **external**: Pipe-separated list of `symbolName:modulePath` (if `includeExternal: true`)

**Example**:
```
nodes:Class:Database|Function:connect|Function:query|Variable:connectionString
edges:connect>query:calls:25|query~connectionString:references:30
cycles:query>processResults>query
external:Logger:winston|config:dotenv
```

---

## Output Schema (JSON Format)

```typescript
interface AnalyzeFileLogicResponse {
  filePath: string;
  lspProvider: string;
  generatedAt: string; // ISO 8601 timestamp
  isPartial: boolean;
  nodes: Array<{
    id: string;
    name: string;
    type: 'class' | 'function' | 'variable';
    line: number;
    isExternal: boolean;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: 'calls' | 'references';
    line: number;
    isCycle: boolean;
  }>;
  cycles: string[][]; // Array of symbol ID chains forming cycles
}
```

---

## Error Responses

```typescript
interface AnalyzeFileLogicError {
  error: string;
  code: 'FILE_NOT_FOUND' | 'UNSUPPORTED_FILE_TYPE' | 'LSP_UNAVAILABLE' | 'LSP_TIMEOUT' | 'ANALYSIS_FAILED';
  message: string;
}
```

**Error Codes**:
- `FILE_NOT_FOUND`: File path does not exist or is not readable
- `UNSUPPORTED_FILE_TYPE`: File extension not in supported list
- `LSP_UNAVAILABLE`: No LSP provider available for file type
- `LSP_TIMEOUT`: LSP provider took > 5 seconds to respond
- `ANALYSIS_FAILED`: Internal error during symbol analysis

**Example Error**:
```json
{
  "error": "LSP_TIMEOUT",
  "code": "LSP_TIMEOUT",
  "message": "Symbol analysis incomplete (LSP timeout after 5 seconds). Partial results returned."
}
```

---

## Usage Examples

### TOON Format (Default)
```json
// Request
{
  "filePath": "/workspace/src/database/connection.ts",
  "includeExternal": false,
  "format": "toon"
}

// Response (string)
"nodes:Class:Connection|Function:connect|Function:disconnect|Function:query|Variable:pool\nedges:connect>query:calls:45|disconnect~pool:references:60\ncycles:query>processData>query\nexternal:"
```

### JSON Format
```json
// Request
{
  "filePath": "/workspace/src/database/connection.ts",
  "includeExternal": true,
  "format": "json"
}

// Response (object)
{
  "filePath": "/workspace/src/database/connection.ts",
  "lspProvider": "typescript",
  "generatedAt": "2026-01-15T10:30:00.000Z",
  "isPartial": false,
  "nodes": [
    {
      "id": "connection.ts:Connection",
      "name": "Connection",
      "type": "class",
      "line": 10,
      "isExternal": false
    },
    {
      "id": "connection.ts:connect",
      "name": "connect",
      "type": "function",
      "line": 25,
      "isExternal": false
    },
    {
      "id": "pg:Client",
      "name": "Client",
      "type": "class",
      "line": 0,
      "isExternal": true
    }
  ],
  "edges": [
    {
      "source": "connection.ts:connect",
      "target": "connection.ts:query",
      "relation": "calls",
      "line": 45,
      "isCycle": false
    },
    {
      "source": "connection.ts:connect",
      "target": "pg:Client",
      "relation": "calls",
      "line": 30,
      "isCycle": false
    }
  ],
  "cycles": [
    ["connection.ts:query", "connection.ts:processData", "connection.ts:query"]
  ]
}
```

---

## Tool Description (for MCP Registration)

```typescript
{
  name: "graphItLive_analyzeFileLogic",
  description: "WHEN: Use this when you need to understand how functions call each other within a single file. WHY: Static analysis of import statements doesn't show internal function calls—this tool uses LSP to trace execution flow symbol-by-symbol. WHAT: Returns symbol nodes (functions, classes, variables) and call edges (who calls whom) with cycle detection, optimized for AI consumption via TOON format (40% fewer tokens than JSON).",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to file to analyze"
      },
      includeExternal: {
        type: "boolean",
        description: "Include calls to imported functions from other files (default: false)"
      },
      format: {
        type: "string",
        enum: ["toon", "json"],
        description: "Output format: 'toon' (compressed, default) or 'json' (verbose)"
      }
    },
    required: ["filePath"]
  }
}
```

---

## Implementation Notes

**TOON Format Compression**:
- Reduces token usage by ~40% compared to JSON for typical call graphs
- Uses single-character delimiters: `|` (pipe), `:` (colon), `>` (calls), `~` (references)
- Omits redundant field names (JSON overhead)
- Newline-separated sections for readability

**LSP Integration**:
- Uses VS Code LSP APIs via extension service layer (NO direct LSP calls from MCP server)
- MCP server sends message to extension: `{ command: 'analyzeSymbols', filePath }`
- Extension calls LSP → returns results to MCP via callback
- Timeout handling: 5-second limit (FR-020)

**Security**:
- Validate `filePath` is within workspace root (prevent path traversal)
- Sanitize file paths before passing to LSP (avoid command injection)
- Rate limit: Max 10 requests per second per client

---

## Summary

MCP tool contract for `graphItLive_analyzeFileLogic` defined with TOON format for token efficiency. Supports both compressed (TOON) and verbose (JSON) output formats. Error handling for LSP timeouts and unavailable providers. Ready for implementation in `src/mcp/McpWorker.ts`.
