# Rust Integration Test Fixtures

This directory contains Rust code fixtures for testing the Graph-It-Live dependency analysis with Rust projects.

## Structure

```
rust-integration/
├── main.rs           # Entry point with USED and UNUSED imports
└── utils/
    ├── mod.rs        # Module declarations
    ├── helpers.rs    # Helper functions (format_data, process_data)
    └── database.rs   # Database functions (connect_db, disconnect_db)
```

## Purpose: Testing Unused Import Detection

The `main.rs` file is specifically designed to test unused dependency filtering:

### Used Imports ✅
- `format_data` from `utils::helpers` - **CALLED** in main()
- `connect_db` from `utils::database` - **CALLED** in main()

### Unused Imports ❌
- `process_data` from `utils::helpers` - imported but **NEVER CALLED**
- `disconnect_db` from `utils::database` - imported but **NEVER CALLED**

## Expected Behavior

### File-Level Dependencies
Both `helpers.rs` and `database.rs` should show as **USED** at the file level because at least one symbol from each file is called.

### Symbol-Level Dependencies
- Symbol graph should only include dependencies for functions that are **actually called**:
  - ✅ `format_data`
  - ✅ `connect_db`
- Unused imports should NOT appear in symbol dependencies:
  - ❌ `process_data` (not in dependencies)
  - ❌ `disconnect_db` (not in dependencies)

### Visual Graph Behavior
When using the "Filter Unused Dependencies" feature in Graph-It-Live:
- File-level edges to `helpers.rs` and `database.rs` remain visible (at least one symbol used)
- No false positives about unused file-level dependencies

## Test Coverage

See [tests/analyzer/RustUnusedImportsIntegration.test.ts](../../tests/analyzer/RustUnusedImportsIntegration.test.ts) for:
1. Detection of called functions in symbol dependencies
2. Exclusion of uncalled (imported-only) functions from dependencies
3. Correct file-level usage verification
4. Accurate dependency counting

This fixture validates that Rust's unused dependency detection works correctly for realistic code patterns where some imports are used and others are not.
