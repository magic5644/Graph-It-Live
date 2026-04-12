# Graph-It-Live Coding Standards

Complete set of development best practices to maintain consistency, quality, and maintainability of the Graph-It-Live project.

## 🏗️ Architecture & Module Organization

### Layer Separation

The project follows a **six-layer architecture**:

- **`src/analyzer/`**: Dependency analysis (Pure Node.js, **NO vscode imports**)
  - AST-based analysis via ts-morph and tree-sitter
  - Caching, indexing, path resolution, SymbolReverseIndex
  - Call graph layer: GraphExtractor, CallGraphIndexer, CallGraphQuery

- **`src/extension/`**: VS Code extension host
  - Orchestration services in `extension/services/`
  - Service container, event hub, message dispatcher
  - File watching, editor navigation, webview management

- **`src/cli/`**: Standalone terminal interface (Pure Node.js, **NO vscode imports**)
  - Published as `graph-it` npm package
  - 9 commands: scan, summary, trace, explain, path, check, serve, tool, update
  - CliRuntime, SymbolRef addressing, ExitCode, CliOutputFormat

- **`src/mcp/`**: MCP server for LLM/AI (Pure Node.js, **NO vscode imports**)
  - Standalone process with stdio transport
  - 21 dependency analysis tools in `mcp/tools/`
  - Zod v4 validation with payload size limits

- **`src/shared/`**: Shared types and utilities
  - Extension ↔ webview message types
  - Constants, utilities, logger, TOON serialization
  - Communication protocols

- **`src/webview/`**: React + ReactFlow / Cytoscape interface
  - React components (browser context)
  - File graph, symbol graph, call graph panels
  - Typed communication via shared protocol

### Strict Rules

- ⚠️ **NEVER** import `vscode` in `analyzer/`, `mcp/`, or `cli/`
- ⚠️ **NEVER** import `node` (raw fs, path) in `webview/`
- ✅ Always use `src/shared/` utilities for paths

---

## 🌐 Cross-Platform Compatibility (MANDATORY)

All paths and operations must work on Windows, Linux, and macOS.

### Path Rules

```typescript
// ❌ FORBIDDEN
const path = `/home/user/file.ts`;           // Hardcoded Unix path
const path = `C:\\Users\\user\\file.ts`;     // Hardcoded Windows path
if (filePath.includes("\\")) { ... }          // Assuming backslashes

// ✅ CORRECT
import path from "node:path";
import { normalizePath } from "@/shared/path";

const fullPath = path.join(baseDir, "src", "file.ts");
const normalized = normalizePath(filePath);   // Converts \ to /, lowercase drive
if (normalized.includes("\\")) { ... }        // Checks for escaped backslashes

// ✅ For Windows path literals in tests
const winPath = String.raw`C:\Users\user\project\file.ts`;
```

### Essential Functions

- `path.join()`: Safe path joining
- `path.resolve()`: Absolute paths
- `normalizePath(path)` from `@/shared/path`: Normalize before Set/Map
- `String.raw`: Template literals with literal backslashes in tests

### Filesystem Considerations

- ❌ Never assume case-sensitive filesystem (Windows is not)
- ✅ Normalize before storing in Set/Map: `set.add(normalizePath(path))`
- ✅ Test Windows cases in cross-platform tests

---

## 🧪 Testing Guidelines

### Principles

- **Unit tests**: Business logic, mocks for external dependencies
- **E2E tests**: Full VS Code integration (90+ tests covering 95% of features)
- **Cross-Platform**: All tests must pass on Windows, Linux, macOS

### Naming Conventions

- `*.test.ts`: Test files (vitest)
- `*.test.tsx`: React component tests
- `tests/fixtures/`: Test data

### Assertion Patterns

```typescript
// ✅ CORRECT
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("ComponentName", () => {
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCallback = vi.fn();
  });

  it("should do something when condition is met", () => {
    expect(result).toBe(expected);
  });
});

// ❌ AVOID
describe("ComponentName", () => {
  const mockCallback = vi.fn(); // No reset between tests
});
```

### Mandatory E2E Tests

Add an e2e test for **EVERY** new user-facing feature:

- VS Code commands
- Configuration settings
- UI interactions
- Multi-language support (TS/JS/Python/Rust/GraphQL)

---

## 📘 TypeScript Strict Mode

### Configuration

- `tsconfig.json`: `strict: true`, `noImplicitAny: true`, `noUnusedLocals: true`
- ❌ Never use `any`
- ✅ Always type explicitly

### Common Patterns

```typescript
// ❌ WRONG - Implicit any type
function parseData(input) {
  return JSON.parse(input);
}

// ✅ CORRECT - Explicit types
function parseData(input: string): Record<string, unknown> {
  return JSON.parse(input) as Record<string, unknown>;
}

// ❌ WRONG - Unused variable
function process(data: Data, options?: Options) {
  processData(data); // options not used
}

// ✅ CORRECT - Remove unused variables
function process(data: Data) {
  processData(data);
}
```

### Type Casts

Use explicit type casting when necessary:

```typescript
// ✅ CORRECT
const result = analysisOutput as AnalyzeFileLogicResult;
const nodeData = (node.data as any).label; // Type narrowing
```

---

## ⚛️ React Best Practices

### Dependencies in useMemo/useCallback

⚠️ **CRITICAL RULE**: NEVER include callback props in dependencies

```typescript
// ❌ FORBIDDEN - Causes re-render loops
const graph = useMemo(() => {
  return buildGraph({ data, callbacks: { onDrillDown } });
}, [data, onDrillDown]); // onDrillDown changes every render!

// ✅ CORRECT - Use useRef for callbacks
const callbacksRef = useRef({ onDrillDown });
callbacksRef.current = { onDrillDown };

const graph = useMemo(() => {
  return buildGraph({ data, callbacks: callbacksRef.current });
}, [data]); // No callbacks in deps
```

### Direct Set/Map

```typescript
// ✅ CORRECT - Sets/Maps compared by reference
const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
const expanded = useMemo(() => {
  return filterGraph(graph, expandedNodes);
}, [graph, expandedNodes]); // Set by reference OK
```

### useEffect Pattern for Reset

```typescript
// ✅ CORRECT - Depends ONLY on reset tokens
useEffect(() => {
  expandAllRef.current = false;
  resetTokenRef.current = undefined;
}, [expandAll, resetToken, currentFilePath]);
```

---

## 🧹 Code Quality & Linting

### ESLint Configuration

- Source of truth: `eslint.config.mjs`
- Run: `npm run lint` before PR
- Auto-fix: `npm run lint:fix`

### Naming Conventions

- Imports: `camelCase` or `PascalCase` (enforced by ESLint)
- Variables: `camelCase`
- Classes/Types: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

```typescript
// ✅ CORRECT
import { FileReader, cacheSize } from "@/analyzer";
class DependencyAnalyzer {}
const MAX_DEPTH = 10;
let currentFile: string;

// ❌ WRONG
import { file_reader, CacheSize } from "@/analyzer";
class dependency_analyzer {}
const maxDepth = 10;
let CURRENT_FILE: string;
```

### Path Alias

Use `@/` for `src/` imports when it improves clarity:

```typescript
// ✅ PREFERRED
import { Spider } from "@/analyzer/Spider";
import { normalizePath } from "@/shared/path";

// ✅ ALSO GOOD
import { buildGraph } from "../utils/buildGraph";
```

---

## 🔒 SonarQube Compliance

### Key Rules to Follow

| Rule      | Pattern                        | Fix                            |
| --------- | ------------------------------ | ------------------------------ |
| **S7780** | `"C:\\path"` without String.raw   | `String.raw`C:\path``          |
| **S1845** | `.replace(/pattern/g, ...)`    | `.replaceAll(old, new)`        |
| **S3776** | Cognitive complexity > 15      | Refactor into functions      |
| **S1542** | Functions without single `return` | Add return/else            |
| **S2715** | Magic values               | Extract to named constants |

### Scanning

```bash
# Analyze a file
npx sonarqube analyze-file src/analyzer/Spider.ts

# Or in VS Code: Tools > SonarQube > Analyze Current File
```

---

## 📦 VS Code Extension Packaging

### ⚠️ CRITICAL Rules

**ZERO source map files (.map) allowed in .vsix package**

```bash
# Production build
npm run build -- --production

# Package the extension
npm run package

# VERIFY (MANDATORY)
npx vsce ls | grep "\.map$"  # Must be empty!

# Or use npm script
npm run package:verify       # ✅ Preferred
```

### External Dependencies

- ✅ Keep external: Native binaries (`tree-sitter`, `tree-sitter-python`, `tree-sitter-rust`)
- ❌ NEVER external: Pure JS/TS modules (will be bundled)

### .vscodeignore Strategy

```
# Top priority: Exclude ALL .map files
**/*.map

# Exclude all node_modules
node_modules/**

# Re-include only required dependencies (specific paths)
!node_modules/tree-sitter/
!node_modules/tree-sitter-python/
!node_modules/node-gyp-build/

# Never use broad re-inclusion
# ❌ !node_modules/package/**  (includes .map files)
```

### Package Size

- ✅ Target: ~16 MB
- ❌ Limit dependencies, exclude tests/docs

---

## 📝 Commit Conventions

### Conventional Commits Format

```
feat: Add symbol-level cycle detection
fix: Handle Windows paths in path resolver
refactor: Extract cache invalidation logic
docs: Update MCP server documentation
test: Add e2e tests for expandAllNodes command
chore: Update dependencies
```

### Pull Request Template

- Brief summary of the feature/fix
- Command execution and results (e.g., `npm test`)
- Screenshots/GIFs for UI changes
- Link to relevant issues/discussions

### Before PR

1. ✅ All tests pass: `npm test`
2. ✅ No TS errors: `npm run check:types`
3. ✅ No lint errors: `npm run lint`
4. ✅ E2E tests for user features: `npm run test:vscode:vsix`
5. ✅ For build config changes: Package verification ✓

---

## 🛡️ Error Handling

### SpiderError Pattern

```typescript
import { SpiderError, SpiderErrorCode } from "@/analyzer";

try {
  const result = await spider.crawl(entryFile);
} catch (error) {
  if (error instanceof SpiderError) {
    switch (error.code) {
      case SpiderErrorCode.FILE_NOT_FOUND:
        console.error(`File not found: ${error.filePath}`);
        break;
      case SpiderErrorCode.PARSE_ERROR:
        console.error(`Parse error in ${error.filePath}: ${error.message}`);
        break;
      default:
        console.error(`Unknown error: ${error.message}`);
    }
  } else {
    console.error("Unexpected error:", error);
  }
}
```

### Validation & Security

- Use **Zod v4** for input validation
- Validate paths to prevent path traversal
- Log errors with context

```typescript
import { z } from "zod";

const filePathSchema = z
  .string()
  .min(1, "File path required")
  .refine((p) => !p.includes(".."), "Path traversal not allowed");

const filePath = filePathSchema.parse(userInput);
```

---

## 🔧 MCP Server Patterns

### Tool Description Format

All tools must follow the **WHEN/WHY/WHAT** pattern:

```typescript
{
  name: "graphItLive_analyzeFile",
  description: `
    **WHEN**: When you need to analyze a single file's symbols and dependencies
    **WHY**: AST parsing is required - you cannot do this without running analysis code
    **WHAT**: Returns symbol graph with all imported symbols and their locations
  `,
  inputSchema: { /* Zod schema */ },
}
```

### Tool Naming

- All tools prefixed: `graphItLive_` (e.g., `graphItLive_setWorkspace`)
- Camel case after prefix
- Descriptive names with action verbs

---

## 🎯 Performance & Optimization

### Debouncing

Use for costly operations (re-indexing, graph refresh):

```typescript
private _debounceTimer?: NodeJS.Timeout;

handleFileChange(filePath: string) {
  if (this._debounceTimer) {
    clearTimeout(this._debounceTimer);
  }
  this._debounceTimer = setTimeout(() => {
    this._reindexFile(filePath);
  }, 500);  // Standard 500ms debounce
}
```

### Caching

- Implement cache with smart invalidation
- Use `ReverseIndex` for lazy cleanup (don't delete immediately)
- See `src/analyzer/Cache.ts`

### Indexing Concurrency

Configuration: `indexingConcurrency` (1-16, default: 4)

- Controlled via VS Code settings
- Respect concurrent limit

---

## 📚 Documentation

### README

- Clear Quick Start with commands
- Installation and dev workflow
- Architecture overview
- Architecture Diagram

### Code Comments

- Document the **WHY**, not the **WHAT**
- Use JSDoc for public exports

```typescript
/**
 * Analyzes file-level dependencies using regex parsing
 * @param filePath - Absolute path to source file
 * @returns Array of imported module paths
 * @throws {SpiderError} If file cannot be read
 */
export function analyzeFileLevelDeps(filePath: string): string[] {
  // ...
}
```

### Instruction Files

Important rules are centralized:

- `.github/instructions/package_validation.instructions.md`: Extension packaging
- `.github/instructions/snyk_rules.instructions.md`: Security scanning
- `.github/instructions/sonarqube_rules.instructions.md`: Code quality
- `.github/copilot-instructions.md`: Complete dev guide

---

## 🔄 Development Workflow

### Initial Setup

```bash
npm install              # Uses --legacy-peer-deps
npm run build           # Bundle via esbuild
npm run watch           # Rebuild on change
npm test                # Run Vitest tests
```

### Development Loop

1. Make TypeScript changes
2. `npm run watch` for continuous rebuild
3. Press F5 in VS Code for Extension Development Host
4. Test in dev extension
5. `npm test` to validate
6. `npm run lint` and `npm run check:types`
7. Commit via Conventional Commits

### Pre-PR Checklist

- [ ] `npm test` - all tests pass
- [ ] `npm run check:types` - 0 TS errors
- [ ] `npm run lint` - 0 ESLint errors
- [ ] `npm run test:vscode:vsix` - E2E tests OK
- [ ] SonarQube scan on modified files
- [ ] Documentation/comments updated
- [ ] Commits properly formatted
- [ ] If build config changed: Package verification ✓

---

## 🚨 Anti-Patterns to Avoid

| Anti-Pattern                     | Reason                                  | Location                 |
| -------------------------------- | --------------------------------------- | -------------------- |
| `any` type                       | Loses type safety                | Everywhere              |
| Callback props in deps           | Re-render cascades and state corruption | React                |
| Dynamic `require()`            | Bundling issues                   | Extension            |
| Hardcoded paths `/` or `\`       | Cross-platform incompatibility          | Everywhere              |
| Skip source map exclusion        | Package size explosion         | Extension            |
| No e2e tests for features   | Undetected regressions               | User features |
| Analysis logic in extension | Couples analyzer to VS Code               | analyzer/, mcp/      |
| Silent error suppression         | Hard to debug bugs              | Everywhere              |

---

## 📊 Code Metrics

### Targets

- **Test Coverage**: ~95% of user features covered by e2e
- **TypeScript**: 0 errors, strict mode
- **ESLint**: 0 errors, configurations applied
- **SonarQube**: Compliance with project rules
- **Package Size**: ~16 MB for .vsix

---

## ✅ Quality Checklist

Before submitting a PR:

- [ ] Code compiles without errors (`npm run check:types`)
- [ ] All tests pass (`npm test`)
- [ ] No lint warnings (`npm run lint`)
- [ ] E2E tests for new user features
- [ ] Package validation if build config changed (`npm run package:verify`)
- [ ] SonarQube scan performed on modified files
- [ ] Cross-platform paths with `path.join()` or `normalizePath()`
- [ ] No `any` types
- [ ] Comments for complex logic
- [ ] Conventional Commits formatted commits
- [ ] No `.map` files in package
- [ ] README/docs updated if visible feature

---

## 📚 Complementary Resources

- **Detailed Architecture**: See `AGENTS.md`
- **MCP Server**: See `src/mcp/README.md` (to be created)
- **Cross-Platform Testing**: See `docs/development/CROSS_PLATFORM_TESTING.md`
- **Performance**: See `docs/architecture/PERFORMANCE_OPTIMIZATIONS.md`
- **Git Workflow**: Conventional Commits style

---

**Maintained by**: Graph-It-Live Development Team  
**Last updated**: January 2026  
**Document version**: 1.0
