# Cross-Platform Testing Guidelines

## Overview

Graph-It-Live must work seamlessly on **Windows, Linux, and macOS**. All tests must be platform-agnostic to ensure reliability across environments.

## Core Principles

### 1. Never Hardcode File Paths

**❌ WRONG:**
```typescript
const testPath = '/Users/test/project/src/index.ts'; // macOS/Linux only
const testPath = 'C:\\Users\\test\\project\\src\\index.ts'; // Windows only
```

**✅ CORRECT:**
```typescript
import * as path from 'node:path';

// Use path.join for cross-platform paths
const testPath = path.join('/', 'Users', 'test', 'project', 'src', 'index.ts');

// Or use path.resolve from project root
const testPath = path.resolve(__dirname, 'fixtures', 'sample-project', 'src', 'index.ts');
```

### 2. Use String.raw for Windows Paths in Test Data

When you need to test Windows-specific paths (backslashes), use `String.raw`:

**❌ WRONG:**
```typescript
'C:\\Users\\test\\project\\src\\index.ts' // Requires double escaping
```

**✅ CORRECT:**
```typescript
String.raw`C:\Users\test\project\src\index.ts` // No escaping needed
```

### 3. Always Use Node.js Path Utilities

```typescript
import * as path from 'node:path';

// Joining paths
const fullPath = path.join(baseDir, 'src', 'utils', 'helper.ts');

// Resolving absolute paths
const absolutePath = path.resolve('src', 'index.ts');

// Getting directory name
const dirName = path.dirname(filePath);

// Getting file extension
const ext = path.extname(filePath);

// Normalizing paths (handles ./ and ../)
const normalizedPath = path.normalize('src/../lib/index.ts');
```

### 4. Normalize Paths for Comparison

Use the project's `normalizePath()` utility from `src/shared/path.ts`:

```typescript
import { normalizePath } from '@/shared/path';

// Converts Windows backslashes to forward slashes
// Lowercases drive letters (C:\ → c:/)
// Removes trailing slashes
const normalized = normalizePath('C:\\Users\\test\\project\\src\\index.ts');
// Result: 'c:/Users/test/project/src/index.ts'
```

### 5. Handle Line Endings

Different platforms use different line endings:
- **Windows**: `\r\n` (CRLF)
- **macOS/Linux**: `\n` (LF)

**For file I/O:**
```typescript
// Reading - normalize line endings
const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');

// Writing - use consistent line endings (usually LF)
fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf-8');
```

**For tests:**
```typescript
// Don't compare strings with line endings directly
expect(output.replace(/\r\n/g, '\n')).toBe(expected.replace(/\r\n/g, '\n'));
```

### 6. Test Fixtures Organization

```
tests/
  fixtures/
    sample-project/
      src/
        index.ts
      tsconfig.json
```

**Access fixtures:**
```typescript
import * as path from 'node:path';

const fixturesDir = path.resolve(__dirname, '..', 'fixtures');
const sampleProject = path.join(fixturesDir, 'sample-project');
const entryFile = path.join(sampleProject, 'src', 'index.ts');
```

## Common Pitfalls

### ❌ Hardcoded Separators
```typescript
const path = baseDir + '/src/index.ts'; // Fails on Windows
```

### ✅ Use path.join
```typescript
const path = path.join(baseDir, 'src', 'index.ts'); // Works everywhere
```

---

### ❌ Case-Sensitive Assumptions
```typescript
// macOS/Linux are case-sensitive, Windows is not
// Don't assume case matters
if (filePath.includes('/SRC/')) { ... } // May fail
```

### ✅ Normalize and Compare
```typescript
import { normalizePath } from '@/shared/path';

const normalized = normalizePath(filePath);
if (normalized.includes('/src/')) { ... } // Consistent
```

---

### ❌ Absolute Path Assumptions
```typescript
// Don't assume paths start with /
if (filePath.startsWith('/')) { ... } // Fails on Windows (C:\...)
```

### ✅ Use path.isAbsolute
```typescript
if (path.isAbsolute(filePath)) { ... } // Works everywhere
```

## Test Helpers for Cross-Platform Compatibility

### Example: Creating Test Path Helpers

```typescript
// tests/helpers/paths.ts
import * as path from 'node:path';

/**
 * Get cross-platform test paths
 */
export function getTestPaths() {
  return {
    unixStyle: path.join('/', 'Users', 'test', 'project', 'src', 'index.ts'),
    windowsStyle: String.raw`C:\Users\test\project\src\index.ts`,
    relative: path.join('src', 'utils', 'helper.ts'),
  };
}

/**
 * Create a cross-platform path from segments
 */
export function createPath(...segments: string[]): string {
  return path.join(...segments);
}
```

### Example: Reducing Nesting Depth

**❌ High Cognitive Complexity:**
```typescript
describe('MySchema', () => {
  it('should validate', () => {
    validPaths.forEach(p => {
      expect(() => MySchema.parse(p)).not.toThrow();
    });
  });
});
```

**✅ Extracted Helper:**
```typescript
function expectSchemaAccepts<T>(schema: { parse: (v: T) => unknown }, value: T) {
  expect(() => schema.parse(value)).not.toThrow();
}

describe('MySchema', () => {
  it('should validate', () => {
    validPaths.forEach(p => expectSchemaAccepts(MySchema, p));
  });
});
```

## CI/CD Considerations

### Test on All Platforms

Ensure your CI runs tests on:
- **Ubuntu** (Linux)
- **macOS**
- **Windows**

Example GitHub Actions matrix:
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node: [20]
runs-on: ${{ matrix.os }}
```

### Environment Variables

Use cross-platform environment variable access:

```typescript
// ✅ Cross-platform
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();

// ❌ Unix-specific
const workspaceRoot = process.env.WORKSPACE_ROOT || '/default/path';
```

## Checklist for New Tests

- [ ] Use `path.join()` or `path.resolve()` for all file paths
- [ ] Use `String.raw` for Windows path literals in test data
- [ ] Normalize paths before comparisons with `normalizePath()`
- [ ] Use `path.isAbsolute()` instead of checking for leading `/`
- [ ] Normalize line endings when comparing file content
- [ ] Extract helpers to reduce nesting depth (keep ≤ 4 levels)
- [ ] Test locally on your platform, let CI validate others
- [ ] Avoid assumptions about case sensitivity
- [ ] Use project fixtures, not hardcoded external paths

## Resources

- [Node.js path module documentation](https://nodejs.org/api/path.html)
- [Cross-Platform Node.js Guide](https://nodejs.org/en/docs/guides/cross-platform/)
- Graph-It-Live path utilities: `src/shared/path.ts`
- Project test patterns: `tests/analyzer/` for examples

## Summary

**Golden Rule:** If you write a path as a string literal, you're probably doing it wrong. Use Node.js `path` utilities for everything.
