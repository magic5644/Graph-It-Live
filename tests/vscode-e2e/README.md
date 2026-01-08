# VS Code E2E Tests

These tests run the extension in a real VS Code instance to verify end-to-end functionality.

## Running Tests

### Development Mode (from source)
Tests the extension code directly from the `src/` directory:
```bash
npm run test:vscode
```

### Production Mode (from .vsix package)
Tests the packaged extension to ensure the .vsix works correctly:
```bash
npm run test:vscode:vsix
```

This will:
1. Build and package the extension (`npm run package`)
2. Compile the test files
3. Launch VS Code with the packaged .vsix installed
4. Run the test suite

**Use this before releasing** to verify the package works as expected.

## What's Tested

- ✅ Extension activation
- ✅ Command execution (`graph-it-live.showGraph`)
- ✅ Webview creation
- ✅ File analysis functionality

## Test Files

- `runTests.ts` - Test runner that launches VS Code
- `suite/index.ts` - Test suite setup
- `suite/extension.test.ts` - Actual test cases

## Troubleshooting

### Tests fail with "Extension not found"
Make sure you've built the extension first:
```bash
npm run build
```

### Tests fail with ".vsix not found"
When using `test:vscode:vsix`, run package first:
```bash
npm run package
npm run test:vscode:vsix
```

### Extension doesn't activate
Check for errors in the VS Code test instance:
- Look for activation errors in the Developer Tools console
- Check that all dependencies are properly bundled
