# Contributing to Graph-It-Live

Thank you for your interest in contributing to Graph-It-Live! This document provides guidelines for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Coding Standards](#coding-standards)
- [Documentation](#documentation)

## Code of Conduct

This project follows a standard code of conduct. Please be respectful and constructive in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:

```bash
git clone https://github.com/YOUR_USERNAME/Graph-It-Live.git
cd Graph-It-Live
```

3. **Add upstream remote**:

```bash
git remote add upstream https://github.com/magic5644/Graph-It-Live.git
```

4. **Install dependencies**:

```bash
npm install
```

5. **Build the extension**:

```bash
npm run build
```

For detailed development setup instructions, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Development Setup

### Prerequisites

- **Node.js**: v18 or higher (v20 LTS recommended)
- **VS Code**: v1.96.0 or higher
- **Git**: For version control

**Note**: No build tools required! The extension uses WebAssembly (WASM) parsers.

### Development Workflow

1. **Create a feature branch**:

```bash
git checkout -b feature/your-feature-name
```

2. **Start development**:

```bash
# Start watch mode for automatic rebuilds
npm run watch

# In VS Code, press F5 to launch Extension Development Host
```

3. **Make your changes** and test them in the Extension Development Host

4. **Run tests**:

```bash
npm test
npm run test:vscode
```

For complete development workflow details, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feature/add-symbol-analysis` - New features
- `fix/parser-crash` - Bug fixes
- `refactor/improve-caching` - Code refactoring
- `docs/update-readme` - Documentation updates
- `test/add-e2e-tests` - Test additions

### Commit Messages

Follow the Conventional Commits style:

- `feat:` - New features or capabilities
- `fix:` - Bug fixes and corrections
- `refactor:` - Code restructuring without behavior changes
- `test:` - Adding or updating tests
- `docs:` - Documentation updates
- `chore:` - Maintenance tasks, dependency updates
- `perf:` - Performance improvements
- `style:` - Code formatting, linting fixes

**Examples**:

```
feat: add symbol-level call hierarchy analysis
fix: resolve cross-platform path handling in tests
refactor: extract common analyzer utilities
test: add e2e tests for unused dependency filtering
docs: update WASM architecture documentation
```

### Code Style

- **TypeScript**: Use strict mode, avoid `any` types
- **ESLint**: Run `npm run lint` before committing
- **Formatting**: Follow existing code style
- **Naming**: Use camelCase for variables/functions, PascalCase for classes/types

For complete coding standards, see `.kiro/steering/coding-standards.md`.

## Testing

### Test Requirements

All contributions must include appropriate tests:

1. **Unit Tests**: For new functions, classes, and modules
   - Use mocked parsers (WASM doesn't work in Node.js)
   - Located in `tests/` with `*.test.ts` naming
   - Run with: `npm test`

2. **E2E Tests**: For new user-facing features (MANDATORY)
   - Use real WASM parsers in VS Code's Electron environment
   - Located in `tests/vscode-e2e/suite/`
   - Run with: `npm run test:vscode` or `npm run test:vscode:vsix`

3. **Property-Based Tests**: For universal properties
   - Use fast-check library
   - Minimum 100 iterations per test
   - Include feature tag and property description

### Running Tests

```bash
# Unit tests (fast, mocked parsers)
npm test

# E2E tests from source (development mode)
npm run test:vscode

# E2E tests from packaged .vsix (production mode, required before release)
npm run test:vscode:vsix

# Coverage report
npm run test:coverage
```

### Cross-Platform Testing

All tests must work on Windows, Linux, and macOS:

- Use `path.join()` or `path.resolve()` for file paths
- Use `String.raw` for Windows path literals in test data
- Normalize paths with `normalizePath()` from `src/shared/path.ts`

For complete testing guidelines, see [DEVELOPMENT.md](DEVELOPMENT.md#testing).

## Submitting Changes

### Before Submitting

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

4. **Update documentation** if needed

### Pull Request Process

1. **Update your branch** with latest upstream changes:

```bash
git fetch upstream
git rebase upstream/main
```

2. **Push your changes** to your fork:

```bash
git push origin feature/your-feature-name
```

3. **Create a Pull Request** on GitHub with:
   - **Clear title** following commit message conventions
   - **Description** of changes and motivation
   - **Test results** (commands and outcomes)
   - **Screenshots/GIFs** for UI changes
   - **Link to related issues** if applicable

4. **Address review feedback** promptly

### Pull Request Checklist

- [ ] Code follows project style and conventions
- [ ] All tests pass (`npm test`, `npm run test:vscode`)
- [ ] New tests added for new functionality
- [ ] E2E tests added for user-facing features
- [ ] Documentation updated if needed
- [ ] Commit messages follow Conventional Commits style
- [ ] Cross-platform compatibility verified
- [ ] Package verification passed (if build config changed)

## Coding Standards

### TypeScript Guidelines

- **Strict mode**: TypeScript is strict, avoid `any` types
- **No unused locals**: Remove unused variables and parameters
- **ESLint compliance**: Run `npm run lint` before committing
- **Type safety**: Use proper types, avoid type assertions when possible

### Code Quality

- **Small functions**: Keep functions focused and concise
- **Nesting depth**: Keep function nesting depth ≤ 4 levels
- **Meaningful names**: Use descriptive variable and function names
- **JSDoc comments**: Add JSDoc for public APIs
- **Error handling**: Use proper error types, provide meaningful messages

### Cross-Platform Compatibility

**CRITICAL**: All code must work on Windows, Linux, and macOS.

**Path Handling**:

```typescript
// ✅ Good - cross-platform
const filePath = path.join(baseDir, 'src', 'file.ts');
const testPath = String.raw`C:\Users\test\file.ts`; // Windows literal

// ❌ Bad - platform-specific
const filePath = baseDir + '/src/file.ts';
const testPath = 'C:\\Users\\test\\file.ts';
```

For complete coding standards, see `.kiro/steering/coding-standards.md`.

## Documentation

### When to Update Documentation

Update documentation when:

- Adding new features or commands
- Changing existing behavior
- Adding new configuration options
- Modifying build or test processes
- Fixing bugs that affect documented behavior

### Documentation Files

- **README.md**: User-facing documentation, features, usage
- **DEVELOPMENT.md**: Development setup, build process, testing
- **CONTRIBUTING.md**: This file, contribution guidelines
- **AGENTS.md**: Repository guidelines for AI agents
- **docs/**: Detailed technical documentation
- **Inline comments**: Code documentation for complex logic

### Documentation Style

- Use clear, concise language
- Include code examples where helpful
- Use proper markdown formatting
- Keep table of contents updated
- Add screenshots/GIFs for UI features

## WASM Architecture

Graph-It-Live uses WebAssembly (WASM) parsers for improved installation reliability and cross-platform compatibility.

### Key Points for Contributors

1. **Unit tests use mocked parsers** - WASM doesn't work in Node.js
2. **E2E tests use real WASM parsers** - Validate in Electron environment
3. **Extension path required** - Parsers need extension path to locate WASM files
4. **Singleton pattern** - Parser instances are cached and reused
5. **Async initialization** - WASM loading is asynchronous

### Testing with WASM

**Unit Tests** (mocked parsers):

```typescript
import { vi } from 'vitest';

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

**Integration Tests** (real WASM):

```typescript
const spider = new SpiderBuilder()
  .withRootDir('/test/project')
  .withExtensionPath('/path/to/extension')
  .build();
```

For complete WASM architecture details, see [DEVELOPMENT.md](DEVELOPMENT.md#wasm-architecture).

## Package Verification

**CRITICAL**: After any change to `esbuild.js`, `.vscodeignore`, or dependencies in `package.json`:

```bash
npm run build -- --production
npm run package
npm run package:verify  # Must show "✅ No .map files in package"
npx vsce ls | grep "\.wasm$"  # Verify WASM files are included
```

For complete package verification details, see [DEVELOPMENT.md](DEVELOPMENT.md#package-verification).

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Ask questions or share ideas
- **Documentation**: Check `docs/` directory for detailed guides
- **DEVELOPMENT.md**: Comprehensive development guide

## License

By contributing to Graph-It-Live, you agree that your contributions will be licensed under the MIT License.

## Thank You!

Thank you for contributing to Graph-It-Live! Your contributions help make dependency analysis better for everyone.
