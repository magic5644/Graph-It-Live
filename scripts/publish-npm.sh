#!/usr/bin/env bash
# Publish @magic5644/graph-it-live to npm.
# Usage: bash scripts/publish-npm.sh <version> [--dry-run]
#
# Steps:
#   1. Validate semver
#   2. Build CLI (production)
#   3. Bump version + rename to scoped in package.json
#   4. npm publish (or dry-run)
#   5. Restore package.json to original state
set -euo pipefail

VERSION="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1

# ── Validation ────────────────────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  echo "Usage: bash scripts/publish-npm.sh <version> [--dry-run]"
  echo "  version examples: 1.0.0  1.2.3-beta.1"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver (e.g. 1.0.0 or 1.2.3-beta.1)"
  exit 1
fi

# ── Setup ─────────────────────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG_JSON="$REPO_ROOT/package.json"
BACKUP="$REPO_ROOT/package.json.bak"

restore() {
  if [[ -f "$BACKUP" ]]; then
    mv "$BACKUP" "$PKG_JSON"
    echo "  ✓ package.json restored"
  fi
}
trap restore EXIT

echo ""
echo "📦 Publishing @magic5644/graph-it-live@$VERSION"
[[ $DRY_RUN -eq 1 ]] && echo "   (dry-run mode — nothing will be pushed to npm)"
echo ""

# ── 1. Save original package.json ────────────────────────────────────────────
cp "$PKG_JSON" "$BACKUP"
echo "  ✓ Saved original package.json"

# ── 1b. Patch version BEFORE build so CLI_VERSION is injected correctly ───────
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
echo "  ✓ version → $VERSION (for build)"

# ── 2. Build production CLI bundle ───────────────────────────────────────────
echo ""
echo "🔨 Building CLI (production)…"
cd "$REPO_ROOT"
# Remove stale .map files left by previous dev builds
find dist/ -name "*.map" -delete 2>/dev/null || true
npm run build:cli -- --production

# ── 3. Verify no .map files in dist ──────────────────────────────────────────
MAP_COUNT=$(find dist/ -name "*.map" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$MAP_COUNT" -gt 0 ]]; then
  echo "Error: $MAP_COUNT .map file(s) found in dist/ — production build should not emit source maps"
  find dist/ -name "*.map"
  exit 1
fi
echo "  ✓ No .map files in dist/"

# ── 4. Patch package.json: scoped name ───────────────────────────────────────
echo ""
echo "📝 Patching package.json…"
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.name = '@magic5644/graph-it-live';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
echo "  ✓ name  → @magic5644/graph-it-live"
echo "  ✓ version → $VERSION"

# ── 5. Show what will be published ───────────────────────────────────────────
echo ""
echo "📋 Files to be published:"
npm pack --dry-run 2>&1 | grep -E "^npm notice" | grep -v "^npm notice Created" || true

# ── 6. Publish ────────────────────────────────────────────────────────────────
echo ""
if [[ $DRY_RUN -eq 1 ]]; then
  echo "🚀 npm publish --access public --dry-run --ignore-scripts"
  npm publish --access public --dry-run --ignore-scripts
else
  echo "🚀 npm publish --access public --ignore-scripts"
  npm publish --access public --ignore-scripts
  echo ""
  echo "✅ Published @magic5644/graph-it-live@$VERSION"
  echo "   https://www.npmjs.com/package/@magic5644/graph-it-live"
fi

# restore() called automatically via trap
