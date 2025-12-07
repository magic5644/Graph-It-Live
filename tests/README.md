# Graph-It-Live Test Suite

This directory contains all tests for the Graph-It-Live VS Code extension.

## Directory Structure

```text
tests/
├── analyzer/           # Unit tests for the analyzer module
├── benchmarks/         # Performance benchmarks
├── coverage/           # Coverage reports (gitignored)
├── e2e/                # End-to-end tests with Playwright
├── extension/          # Extension host tests
├── fixtures/           # Test fixtures and sample files
├── mcp/                # MCP server tests
├── vscode-e2e/         # VSCode integration tests
└── webview/            # Webview/React component tests
```

## Test Categories

### Unit Tests (Vitest)

Location: `tests/analyzer/`, `tests/webview/`, `tests/mcp/`

Fast, isolated tests for individual modules. These tests mock external dependencies like the file system and VS Code APIs.

**Key test files:**

- `Spider.test.ts` - Dependency crawling logic
- `SymbolAnalyzer.test.ts` - AST-based symbol extraction
- `SignatureAnalyzer.test.ts` - Breaking change detection
- `Cache.test.ts` - Caching behavior
- `ReverseIndex.test.ts` - Reverse dependency lookups
- `Parser.test.ts` - Import statement parsing

### Benchmark Tests (Vitest)

Location: `tests/benchmarks/`

Performance tests to measure and track execution time of critical operations.

**Benchmarks include:**

- Parsing performance for large files
- Crawling speed for deep dependency trees
- Symbol analysis throughput

### MCP Server Tests

Location: `tests/mcp/`

Tests for the Model Context Protocol server that exposes dependency analysis to AI/LLM tools.

**Coverage:**

- Tool registration and discovery
- Request/response handling
- Worker thread communication

### End-to-End Tests with Playwright

Location: `tests/e2e/`

Browser-based tests for the webview React application. These tests verify the graph visualization and user interactions.

**Test scenarios:**

- Graph rendering with nodes and edges
- Node expansion and collapse
- Symbol drill-down navigation
- Search and filter functionality

### VSCode Integration Tests

Location: `tests/vscode-e2e/`

Tests that run inside the VS Code Extension Development Host. These verify the extension integrates correctly with VS Code APIs.

**Coverage:**

- Command registration
- Webview panel creation
- File watchers and event handling
- Configuration settings

## Running Tests

### All Unit Tests

```bash
npm test
```

### Unit Tests in Watch Mode

```bash
npm run test:watch
```

### Benchmark Tests

```bash
npm run test:bench
```

### Playwright E2E

```bash
npx playwright test
```

### VSCode E2E

```bash
npm run test:vscode
```

## Test Coverage

### Generate Coverage Report

```bash
npm run test:coverage
```

### View Coverage Report

Coverage reports are generated in `tests/coverage/` and can be viewed in a browser:

```bash
open tests/coverage/index.html
```

## Writing Tests

### Analyzer Tests Guidelines

1. Use `memfs` for file system mocking
2. Import from `@/analyzer/...` using the path alias
3. Place fixtures in `tests/fixtures/`
4. Keep tests focused on a single behavior

**Example:**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '@/analyzer/Spider';
import { createFsFromVolume, Volume } from 'memfs';

describe('Spider', () => {
  let spider: Spider;
  let vol: Volume;

  beforeEach(() => {
    vol = new Volume();
    const fs = createFsFromVolume(vol);
    spider = new Spider({ fs: fs as any });
  });

  it('should crawl dependencies', async () => {
    vol.fromJSON({
      '/src/index.ts': 'import { foo } from "./foo";',
      '/src/foo.ts': 'export const foo = 1;'
    });

    const graph = await spider.crawl('/src/index.ts');
    expect(graph.edges).toContainEqual({
      source: '/src/index.ts',
      target: '/src/foo.ts'
    });
  });
});
```

### Webview Tests Guidelines

1. Test React hooks with `@testing-library/react-hooks`
2. Test utility functions in isolation
3. Mock VS Code `postMessage` API

### E2E Tests Guidelines

1. Use Playwright page objects for reusable interactions
2. Wait for graph animations to complete before assertions
3. Take screenshots on failure for debugging

## Configuration Files

| File | Purpose |
|------|---------|
| `vitest.config.mts` | Unit test configuration |
| `vitest.benchmark.config.mts` | Benchmark configuration |
| `playwright.config.ts` | E2E test configuration |
| `tsconfig.test.json` | TypeScript config for tests |

## CI/CD Integration

Tests run automatically on:

- Pull request creation
- Push to `main` branch
- Nightly scheduled runs

See `.github/workflows/test.yml` for the full CI configuration.
