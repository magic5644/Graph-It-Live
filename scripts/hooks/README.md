# Git Hooks for Graph-It-Live

This directory contains Git hooks for automated validation during development workflow.

## Available Hooks

### 1. Pre-Commit Hook
**File**: `pre-commit`  
**When**: Runs before `git commit` completes  
**Purpose**: Validate layer isolation boundaries

**Checks**:
- ✅ No `vscode` imports in `src/analyzer/`
- ✅ No `vscode` imports in `src/mcp/`
- ⚠️  Reminds to validate package if build config changed

**Example Output**:
```bash
🔍 Running pre-commit validation...
📁 Build or layer files changed - running layer isolation check...
✅ PASS: Layer isolation intact
⚠️  Build configuration changed. After commit, run:
  npm run package
  npm run package:verify
✅ Pre-commit validation passed
```

**Bypass** (not recommended):
```bash
git commit --no-verify
```

---

### 2. Pre-Push Hook
**File**: `pre-push`  
**When**: Runs before `git push` completes  
**Purpose**: Full package validation on critical branches

**Triggers on**: `main`, `develop`, `release/*` branches  
**Skips on**: Feature branches

**Checks**:
- ✅ Zero `.map` files in package (CRITICAL)
- ✅ All 8 WASM files present
- ✅ Package size reasonable (~16 MB, warn if > 20 MB)

**Example Output**:
```bash
🔍 Running pre-push validation...
📦 Critical branch detected: main
Running full package validation...
Building extension...
Creating package...
Checking for source maps...
✅ No source maps found
Checking WASM files...
✅ All 8 WASM files present
Checking package size...
✅ Package size OK: 15 MB

✅ Pre-push validation passed
📦 Package is ready for release
```

**Bypass** (not recommended):
```bash
git push --no-verify
```

---

### 3. Post-Build Hook
**File**: `post-build`  
**When**: Run manually after `npm run build`  
**Purpose**: Verify WASM files and query files copied correctly

**Checks**:
- ✅ `dist/wasm/` directory exists
- ✅ All 8 WASM files present
- ✅ All 3 query files present
- 📊 Lists built bundles with sizes

**Usage**:
```bash
npm run build && bash scripts/hooks/post-build
```

**Example Output**:
```bash
🔍 Post-build verification...
Checking WASM files...
✅ All 8 WASM files present
Checking query files...
✅ All 3 query files present

📦 Build output:
  dist/extension.js - 2.1M
  dist/webview.js - 1.8M
  dist/callgraph.js - 856K
  dist/mcpServer.mjs - 1.2M
  dist/indexerWorker.js - 524K
  dist/astWorker.js - 489K
  dist/mcpWorker.js - 445K
  dist/graph-it.js - 1.5M

✅ Post-build verification passed
✅ Build artifacts ready
```

---

## Installation

### Quick Install

```bash
# From repository root
bash scripts/install-hooks.sh
```

**Output**:
```
📦 Installing Git hooks...
✅ Installed: pre-commit
✅ Installed: pre-push

✅ Git hooks installed successfully

Installed hooks:
  - pre-commit: Layer isolation check
  - pre-push: Package validation (main/develop/release branches)

To bypass hooks (not recommended):
  git commit --no-verify
  git push --no-verify
```

### Manual Install

```bash
# Copy hooks to .git/hooks/
cp scripts/hooks/pre-commit .git/hooks/pre-commit
cp scripts/hooks/pre-push .git/hooks/pre-push

# Make executable
chmod +x .git/hooks/pre-commit
chmod +x .git/hooks/pre-push
```

### Verify Installation

```bash
# Check hooks are executable
ls -l .git/hooks/pre-commit .git/hooks/pre-push

# Expected output:
# -rwxr-xr-x  1 user  staff  1234 Jan 1 12:00 .git/hooks/pre-commit
# -rwxr-xr-x  1 user  staff  2345 Jan 1 12:00 .git/hooks/pre-push
```

---

## Hook Execution Flow

### Pre-Commit Flow
```
git commit
    ↓
Check changed files
    ↓
If analyzer/ or mcp/ modified:
    ↓
Scan for vscode imports
    ↓
If found: BLOCK commit
    ↓
If not found: ALLOW commit
```

### Pre-Push Flow
```
git push
    ↓
Check current branch
    ↓
If main/develop/release:
    ↓
Run full package validation
    ↓
Check .map files (CRITICAL)
    ↓
If found: BLOCK push
    ↓
Check WASM files (8 required)
    ↓
If missing: BLOCK push
    ↓
Check package size
    ↓
If > 20 MB: WARN (but allow)
    ↓
ALLOW push
    ↓
If feature branch:
    ↓
Skip validation, ALLOW push
```

---

## Troubleshooting

### Hook Not Running

**Symptom**: Hook doesn't execute on commit/push

**Causes**:
1. Hook not executable: `chmod +x .git/hooks/pre-commit`
2. Hook not in `.git/hooks/`: Check installation
3. Using `--no-verify`: Bypasses hooks

### Hook Fails with Permission Error

**Symptom**: `permission denied: .git/hooks/pre-commit`

**Fix**:
```bash
chmod +x .git/hooks/pre-commit
chmod +x .git/hooks/pre-push
```

### False Positive: vscode Import in Comment

**Symptom**: Hook detects vscode import in comment

**Example**:
```typescript
// TODO: Remove vscode import
```

**Fix**: Update hook regex to exclude comments (advanced)  
**Workaround**: Rephrase comment or use `--no-verify` (not recommended)

### Hook Takes Too Long

**Symptom**: Pre-push hook takes > 2 minutes

**Cause**: Full package build on every push

**Solutions**:
1. **Keep .vsix cached**: Don't delete between pushes
2. **Skip on feature branches**: Hook already does this
3. **Use `--no-verify` sparingly**: Only for known-safe pushes

---

## Customization

### Modify Pre-Commit Hook

**Add additional checks**:

```bash
# Edit scripts/hooks/pre-commit

# Add after existing checks:
echo "Running custom check..."
if some_command; then
  echo "✅ Custom check passed"
else
  echo "❌ Custom check failed"
  exit 1
fi
```

### Modify Pre-Push Hook

**Change branch triggers**:

```bash
# Edit scripts/hooks/pre-push

# Change this line:
if [[ "$CURRENT_BRANCH" =~ ^(main|develop|release/.*)$ ]]; then

# To include more branches:
if [[ "$CURRENT_BRANCH" =~ ^(main|develop|staging|release/.*)$ ]]; then
```

### Disable Specific Checks

**Skip .map file check** (not recommended):

```bash
# Comment out in pre-push:
# MAPS=$(npx vsce ls 2>/dev/null | grep "\.map$" || true)
# if [ -n "$MAPS" ]; then
#   echo "❌ FAIL: .map files found"
#   exit 1
# fi
```

---

## Related Documentation

- [Package Validator Agent](../../.agents/agents/package-validator.md)
- [Architecture Guardian Agent](../../.agents/agents/architecture-guardian.md)
- [Build & Packaging](../../docs/agent-instructions/build-packaging.md)
- [Architecture](../../docs/agent-instructions/architecture.md)

## CI/CD Integration

These hooks are local. For CI/CD, see:
- [GitHub Actions Workflows](../../.github/workflows/)
- [Package Validation Instructions](../../.github/instructions/package_validation.instructions.md)
