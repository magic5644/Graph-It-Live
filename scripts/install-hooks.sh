#!/bin/bash
# Install Git hooks for Graph-It-Live

HOOKS_DIR=".git/hooks"
SCRIPTS_DIR="scripts/hooks"

echo "📦 Installing Git hooks..."

# Ensure .git/hooks exists
if [ ! -d "$HOOKS_DIR" ]; then
  echo "❌ Error: .git/hooks directory not found"
  echo "Are you in the repository root?"
  exit 1
fi

# Copy hooks
for hook in pre-commit pre-push; do
  if [ -f "$SCRIPTS_DIR/$hook" ]; then
    cp "$SCRIPTS_DIR/$hook" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "✅ Installed: $hook"
  else
    echo "⚠️  Warning: $SCRIPTS_DIR/$hook not found"
  fi
done

echo ""
echo "✅ Git hooks installed successfully"
echo ""
echo "Installed hooks:"
echo "  - pre-commit: Layer isolation check"
echo "  - pre-push: Package validation (main/develop/release branches)"
echo ""
echo "To bypass hooks (not recommended):"
echo "  git commit --no-verify"
echo "  git push --no-verify"
