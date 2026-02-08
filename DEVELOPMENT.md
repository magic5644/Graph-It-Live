# Development Guide

This guide provides comprehensive instructions for developing, building, testing, and packaging Graph-It-Live.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Build Process](#build-process)
- [Testing](#testing)
- [WASM Architecture](#wasm-architecture)
- [Package Verification](#package-verification)
- [Development Workflow](#development-workflow)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js**: v18 or higher (v20 LTS recommended)
- **VS Code**: v1.96.0 or higher
- **Git**: For version control

**Note**: No build tools required! The extension uses WebAssembly (WASM) parsers, eliminating the need for native compilation tools (Python, C++ compiler, etc.) during installation.

## Setup

1. **Clone the repository**:

```bash
git clone https://github.com/magic5644/Graph-It-Live.git
cd Graph-It-Live
```

2. **Install dependencies**:

```bash
npm install
```

This will install all dependencies including `web-tree-sitter` and `tree-sitter-wasms`. No native compilation is required.

3. **Build the extension**:

```bash
npm run build
```

This will:
- Bundle the extension via `esbuild.js`
- Automatically copy WASM files from `node_modules` to `dist/wasm/`
- Create all necessary output files in `dist/`

4. **Run in development mode**:

- Open the project in VS Code
- Press `F5` to launch the Extension Development Host
- The extension will be loaded in a new VS Code window

## Build Process

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build the extension bundle (development mode) |
| `npm run build -- --production` | Build with production optimizations |
| `npm run watch` | Rebuild automatically on file changes |

### Build Output

The build process creates the following files in `dist/`:

```
dist/
├── wasm/
│   ├── tree-sitter.wasm          # Core web-tree-sitter WASM runtime
│   ├── tree-sitter-python.wasm   # Python grammar WASM
│   └── tree-sitter-rust.wasm     # Rust grammar WASM
├── extension.js                   # Main extension bundle (CommonJS)
├── indexerWorker.js               # Background indexing worker (CommonJS)
├── astWorker.js                   # Symbol analysis worker (CommonJS)
├── mcpServer.mjs                  # MCP server entry point (ESM)
├── mcpWorker.js                   # MCP operations worker (CommonJS)
└── webview.js                     # React UI bundle (IIFE)
```

### WASM File Handling

The build process automatically:

1. **Copies WASM files** from `node_modules` to `dist/wasm/`:
   - `node_modules/web-tree-sitter/tree-sitter.wasm` → `dist/wasm/tree-sitter.wasm`
   - `node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm` → `dist/wasm/tree-sitter-python.wasm`
   - `node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm` → `dist/wasm/tree-sitter-rust.wasm`

2. **Includes WASM files in .vsix package** via `.vscodeignore` patterns

3. **Validates WASM files exist** before packaging

### esbuild Configuration

The `esbuild.js` configuration:

- Uses `file` loader for `.wasm` files (copies as-is, doesn't bundle)
- Creates separate bundles for extension, workers, and webview
- Handles external dependencies correctly
- Copies WASM files after bundling completes

## Testing

### Test Categories

Graph-It-Live uses multiple testing strategies:

#### Unit Tests (Vitest)

**Command**: `npm test` or `npm run test:unit`

**Characteristics**:
- Fast execution (mocked parsers)
- No WASM initialization required
- Tests individual components in isolation
- Located in `tests/` directory with `*.test.ts` naming

**Important**: Unit tests use **mocked parsers** because web-tree-sitter has known compatibility issues in Node.js environments. This is expected and does not affect production functionality.

**Example test setup**:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('MyFeature', () => {
  beforeEach(() => {
    // Mock WASM factory to avoid real WASM initialization
    vi.mock('@/analyzer/languages/WasmParserFactory', () => ({
      WasmParserFactory: {
        getInstance: vi.fn().mockReturnValue({
          init: vi.fn().mockResolvedValue(undefined),
          getParser: vi.fn().mockResolvedValue({
            parse: vi.fn().mockReturnValue({ rootNode: {} }),
          }),
        }),
      },
    }));
  });
  
  it('should work with mocked parser', async () => {
    // Test code here
  });
});
```

#### Property-Based Tests (fast-check)

**Command**: `npm test` (included in unit tests)

**Characteristics**:
- Tests universal properties across many inputs (100+ iterations)
- Uses fast-check library for property generation
- Validates correctness properties from design document
- Uses mocked parsers for speed

**Example**:

```typescript
import fc from 'fast-check';

test('Python import extraction completeness', async () => {
  await fc.assert(
    fc.asyncProperty(
      pythonFileWithImportsGenerator(),
      async (pythonFile) => {
        const parser = new PythonParser(testRoot, extensionPath);
        const deps = await parser.parseImports(pythonFile.path);
        
        // Verify all imports are extracted
        for (const expectedImport of pythonFile.imports) {
          expect(deps).toContainEqual(
            expect.objectContaining({
              module: expectedImport.module,
              line: expectedImport.line,
            })
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});
```

#### E2E Tests (VS Code Extension Testing)

**Commands**:
- `npm run test:vscode` - Run from source (development mode)
- `npm run test:vscode:vsix` - Run from packaged .vsix (production mode, **required before release**)

**Characteristics**:
- Tests complete extension in VS Code's Electron environment
- Uses **real WASM parsers** (not mocked)
- Validates all user-facing features
- Located in `tests/vscode-e2e/suite/`
- 90+ comprehensive tests covering all major functionality

**Coverage**:
- Extension activation and all commands
- Settings (read/write operations)
- Performance profiles (default/low-memory/high-performance)
- Multi-language analysis (TypeScript, JavaScript, Python, Rust, GraphQL)
- Cycle detection and unused filtering
- Symbol-level analysis with LSP-based call hierarchy
- Node operations (expand, collapse, filter toggle)
- Reverse dependencies across languages
- Cross-platform path handling

**Important**: Always run `npm run test:vscode:vsix` before releasing to verify the packaged extension works correctly with real WASM parsers.

#### Benchmark Tests

**Command**: `npm run test:bench`

**Characteristics**:
- Performance benchmarks for critical operations
- Located in `tests/benchmarks/` with `*.bench.ts` naming
- Uses Vitest benchmark utilities

**Note**: WASM benchmarks may fail in Node.js (expected). Use E2E tests to validate WASM performance in production.

#### Coverage Reports

**Command**: `npm run test:coverage`

**Output**: `tests/coverage/` directory

**Target**: 90%+ coverage for critical paths

### Testing Best Practices

1. **Always mock parsers in unit tests** - WASM doesn't work in Node.js
2. **Use E2E tests for WASM validation** - Real parsers work in Electron
3. **Add E2E test for new features** - Any user-facing feature needs E2E coverage
4. **Test cross-platform** - All tests must work on Windows, Linux, and macOS
5. **Use property-based tests** - Verify universal properties across many inputs

## WASM Architecture

### Overview

Graph-It-Live uses WebAssembly (WASM) versions of tree-sitter parsers for improved installation reliability, security, and cross-platform compatibility.

### Benefits

- ✅ **No Native Compilation**: Installation doesn't require build tools (Python, C++ compiler, etc.)
- ✅ **Cross-Platform**: Works identically on Windows, Linux, and macOS
- ✅ **Security**: Pure JavaScript and WASM (no native binaries)
- ✅ **Lightweight**: WASM files are small (~2-3 MB total)
- ✅ **Reliable**: No code signature verification issues in restrictive environments
- ✅ **Reduced Package Size**: WASM files smaller than native binaries

### Architecture Components

```
VS Code Extension Host (Electron)
├── WasmParserFactory (Singleton)
│   ├── tree-sitter.wasm (Core WASM runtime)
│   ├── tree-sitter-python.wasm (Python grammar)
│   └── tree-sitter-rust.wasm (Rust grammar)
├── PythonParser (uses WASM)
├── RustParser (uses WASM)
└── Symbol Analyzers (use WASM)
```

### Initialization Flow

1. Extension activates and provides extension path to parsers
2. First parse operation triggers WASM initialization
3. WasmParserFactory loads core `tree-sitter.wasm`
4. Language-specific WASM files loaded on demand
5. Parser instances cached and reused (singleton pattern)

### Testing with WASM

**Unit Tests**: Use mocked parsers (WASM doesn't work in Node.js)

```typescript
// Mock WASM factory in unit tests
vi.mock('@/analyzer/languages/WasmParserFactory', () => ({
  WasmParserFactory: {
    getInstance: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      getParser: vi.fn().mockResolvedValue({
        parse: vi.fn().mockReturnValue({ rootNode: {} }),
      }),
    }),
  },
}));
```

**Integration Tests**: Provide extension path for real WASM initialization

```typescript
const spider = new SpiderBuilder()
  .withRootDir('/test/project')
  .withExtensionPath('/path/to/extension')
  .build();
```

**E2E Tests**: Use real WASM parsers in VS Code's Electron environment

### Known Limitations

- **Node.js Compatibility**: web-tree-sitter has known issues in Node.js environments (LinkError: WebAssembly.instantiate)
- **Test Failures**: Some unit tests and benchmarks may fail due to WASM Node.js compatibility issues
- **E2E Tests**: Extension works correctly in VS Code despite unit test failures
- **Workaround**: Tests that require parsers should provide extension path or mock WASM initialization
- **Benchmark Limitation**: Cannot measure WASM performance in Node.js (use E2E tests for validation)

## Package Verification

### Mandatory Verification Steps

**CRITICAL**: After any change to `esbuild.js`, `.vscodeignore`, or dependencies in `package.json`, you MUST verify the package:

```bash
# 1. Build with production optimizations
npm run build -- --production

# 2. Create the .vsix package
npm run package

# 3. Verify no .map files (MANDATORY)
npm run package:verify
# Expected: "✅ No .map files in package"

# 4. Verify WASM files are included
npx vsce ls | grep "\.wasm$"
# Expected output:
# dist/wasm/tree-sitter.wasm
# dist/wasm/tree-sitter-python.wasm
# dist/wasm/tree-sitter-rust.wasm

# 5. Check package size
ls -lh *.vsix
# Expected: ~12 MB
```

### What to Verify

1. **No .map files**: Source maps must be excluded from the package
2. **WASM files included**: All three WASM files must be present
3. **Package size**: Should be around 12 MB (reasonable size)
4. **All tests pass**: Run `npm run test:vscode:vsix` before release

### Troubleshooting Package Issues

**Problem**: .map files found in package

**Solution**: Update `.vscodeignore` to exclude all `.map` files:

```
**/*.map
```

**Problem**: WASM files missing from package

**Solution**: 
1. Verify WASM files exist in `dist/wasm/`
2. Check `.vscodeignore` doesn't exclude `dist/wasm/*.wasm`
3. Rebuild: `npm run build`

**Problem**: Package size too large (>15 MB)

**Solution**:
1. Verify `.map` files are excluded
2. Check for unnecessary files in package: `npx vsce ls`
3. Update `.vscodeignore` to exclude unnecessary files

## Development Workflow

### Daily Development

1. **Start development**:

```bash
# Open project in VS Code
code .

# Start watch mode for automatic rebuilds
npm run watch
```

2. **Run extension**:

- Press `F5` to launch Extension Development Host
- Make changes to code
- Reload extension: `Ctrl+R` (Windows/Linux) or `Cmd+R` (macOS) in Extension Development Host

3. **Run tests**:

```bash
# Run unit tests (fast, mocked parsers)
npm test

# Run E2E tests (slower, real WASM parsers)
npm run test:vscode
```

### Before Committing

1. **Lint and type check**:

```bash
npm run lint
npm run check:types
```

2. **Run all tests**:

```bash
npm test
npm run test:vscode
```

3. **Verify package** (if build config changed):

```bash
npm run build -- --production
npm run package
npm run package:verify
```

### Before Releasing

1. **Run full test suite**:

```bash
npm test
npm run test:coverage
npm run test:vscode:vsix  # MANDATORY - tests packaged extension
```

2. **Verify package**:

```bash
npm run build -- --production
npm run package
npm run package:verify
npx vsce ls | grep "\.wasm$"  # Verify WASM files
ls -lh *.vsix  # Check size
```

3. **Test installation**:

```bash
# Install the .vsix in a clean VS Code instance
code --install-extension graph-it-live-*.vsix
```

4. **Update changelog**:

- Document all changes in `changelog.md`
- Follow existing format and conventions

### Cross-Platform Development

**Important**: All code and tests must work on Windows, Linux, and macOS.

**Path Handling**:

```typescript
// ✅ Good - cross-platform
const filePath = path.join(baseDir, 'src', 'file.ts');
const testPath = String.raw`C:\Users\test\file.ts`; // Windows literal

// ❌ Bad - platform-specific
const filePath = baseDir + '/src/file.ts';
const testPath = 'C:\\Users\\test\\file.ts';
```

**Testing**:

- Use `path.join()` or `path.resolve()` for file paths
- Use `String.raw` for Windows path literals in test data
- Normalize paths with `normalizePath()` from `src/shared/path.ts`
- Test on multiple platforms if possible

## Troubleshooting

### WASM Loading Failures

#### Error: "Extension path required for WASM parser initialization"

**Cause**: Parser created without extension path parameter

**Solution**: Pass `extensionPath` to parser constructors or use SpiderBuilder with `.withExtensionPath()`

```typescript
const spider = new SpiderBuilder()
  .withRootDir(workspaceRoot)
  .withExtensionPath(context.extensionPath)
  .build();
```

#### Error: "LinkError: WebAssembly.instantiate()"

**Cause**: web-tree-sitter compatibility issue in Node.js

**Solution**: This is expected in unit tests; extension works correctly in VS Code runtime

**Workaround**: Use mocked parsers in unit tests, real WASM in E2E tests

#### Error: "WASM file not found"

**Cause**: WASM files missing from `dist/wasm/` directory

**Solution**: 
1. Run `npm run build` to copy WASM files
2. Verify files exist: `ls -lh dist/wasm/*.wasm`
3. If issue persists, reinstall dependencies: `npm ci`

#### Error: "Failed to load language WASM"

**Cause**: WASM file corrupted or incompatible version

**Solution**: 
1. Delete `dist/wasm/` directory
2. Run `npm run build` to recopy WASM files
3. If issue persists, reinstall dependencies: `npm ci`

### Build Issues

#### Build fails with "Cannot find module"

**Solution**:
1. Clean build artifacts: `rm -rf dist/ out/`
2. Reinstall dependencies: `npm ci`
3. Rebuild: `npm run build`

#### Watch mode not detecting changes

**Solution**:
1. Stop watch mode (`Ctrl+C`)
2. Clean build artifacts: `rm -rf dist/ out/`
3. Restart watch mode: `npm run watch`

### Test Issues

#### Unit tests fail with WASM errors

**Expected**: Unit tests use mocked parsers and should not initialize WASM

**Solution**: Verify test setup includes WASM factory mock:

```typescript
vi.mock('@/analyzer/languages/WasmParserFactory', () => ({
  WasmParserFactory: {
    getInstance: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      getParser: vi.fn().mockResolvedValue({
        parse: vi.fn().mockReturnValue({ rootNode: {} }),
      }),
    }),
  },
}));
```

#### E2E tests fail with "Extension not found"

**Solution**:
1. Rebuild extension: `npm run build`
2. For `test:vscode:vsix`, rebuild package: `npm run package`
3. Verify extension is built: `ls -lh dist/extension.js`

#### E2E tests timeout

**Solution**:
1. Increase timeout in test configuration
2. Check for infinite loops or blocking operations
3. Verify WASM files are loading correctly

### Package Issues

#### .map files in package

**Solution**: Update `.vscodeignore` to exclude all `.map` files:

```
**/*.map
```

#### WASM files missing from package

**Solution**:
1. Verify WASM files exist: `ls -lh dist/wasm/*.wasm`
2. Check `.vscodeignore` doesn't exclude `dist/wasm/*.wasm`
3. Rebuild and repackage: `npm run build && npm run package`

#### Package size too large

**Solution**:
1. Verify `.map` files are excluded
2. Check for unnecessary files: `npx vsce ls`
3. Update `.vscodeignore` to exclude unnecessary files

## Additional Resources

- **Project Structure**: See `.kiro/steering/project-structure.md`
- **Testing Guidelines**: See `.kiro/steering/testing-guidelines.md`
- **Coding Standards**: See `.kiro/steering/coding-standards.md`
- **WASM Migration Spec**: See `.kiro/specs/tree-sitter-wasm-migration/`
- **AGENTS.md**: Comprehensive repository guidelines for AI agents

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **Discussions**: Ask questions or share ideas
- **Documentation**: Check `docs/` directory for detailed guides

## License

MIT License - see [LICENSE](LICENSE) file for details.
