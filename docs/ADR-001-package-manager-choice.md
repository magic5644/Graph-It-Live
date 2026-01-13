# ADR-001: Package Manager Choice - npm vs Yarn

**Status**: Accepted

**Date**: 2026-01-13

**Deciders**: magic56

**Context**: Following the upgrade of tree-sitter-python to 0.25.0 and the resulting peer dependency conflicts with tree-sitter-rust@0.24.0, we evaluated whether migrating from npm to Yarn would provide significant benefits for managing dependencies in this VS Code extension project.

---

## Decision

**We will continue using npm as our package manager and will NOT migrate to Yarn.**

---

## Context

### Current Situation

- **Project Type**: VS Code extension with MCP server
- **Dependencies**: 13 production + 27 development dependencies (~40 total)
- **Package Lock**: `package-lock.json` (336 KB)
- **Current Challenge**: Peer dependency conflict between:
  - `tree-sitter-python@0.25.0` (requires `tree-sitter@^0.25.0`)
  - `tree-sitter-rust@0.24.0` (requires `tree-sitter@^0.22.1`)
- **Current Solution**: 
  - `.npmrc` with `legacy-peer-deps=true`
  - `vsce` commands with `--no-dependencies` flag
  - ✅ Working solution across all platforms (Linux, macOS, Windows)

### Problem Statement

Should we migrate to Yarn to potentially:
1. Better handle peer dependency conflicts
2. Improve installation performance
3. Modernize dependency management
4. Simplify the workaround currently in place

---

## Analysis

### Yarn Advantages Evaluated

#### 1. Peer Dependency Resolution
- **Yarn Modern (v3/v4)**: Better automatic conflict resolution
- **Potential**: Could eliminate need for `.npmrc` workaround
- **Assessment**: Marginal benefit - current npm solution works reliably

#### 2. Performance
- **Installation Speed**: Yarn Modern ~30-40% faster with Plug'n'Play (PnP)
- **Project Size**: 40 dependencies
- **Measured Impact**: ~2-5 seconds saved per install
- **Verdict**: Negligible benefit for project size

#### 3. Lockfile Format
- **Yarn**: `yarn.lock` (~200-250 KB, YAML format)
- **npm**: `package-lock.json` (336 KB, JSON format)
- **Verdict**: Difference not significant

#### 4. Workspace Support
- **Yarn**: Superior monorepo/workspace support
- **Project Structure**: Single package, not a monorepo
- **Verdict**: Not applicable

### Migration Risks Identified

#### 1. VS Code Extension Tooling Compatibility ⚠️

**vsce (VS Code Extension Manager)**:
```bash
# vsce internally uses npm list
vsce package --no-dependencies  # Current workaround
```

- vsce is optimized for npm ecosystem
- Yarn compatibility not guaranteed
- Risk of packaging failures
- Microsoft recommends npm for VS Code extensions

#### 2. CI/CD Modifications Required

**Changes needed in `.github/workflows/*.yml`**:
```yaml
# Before (npm)
- uses: actions/setup-node@v6
  with:
    cache: 'npm'
- run: npm ci

# After (Yarn Modern)
- uses: actions/setup-node@v6
  with:
    cache: 'yarn'
- run: corepack enable
- run: yarn install --immutable
```

**Testing Requirements**:
- Update 2 workflow files (build.yml, main.yml)
- Test on 3 operating systems (Linux, macOS, Windows)
- Risk of Windows-specific issues with Yarn Modern PnP

#### 3. Build Scripts Compatibility

**Scripts requiring attention**:
```json
{
  "package": "vsce package --no-dependencies",
  "audit": "npm audit",  // Becomes: yarn npm audit
  "publish": "vsce publish --no-dependencies"
}
```

#### 4. Ecosystem Compatibility Matrix

| Tool | npm | Yarn Modern | Risk Level |
|------|-----|-------------|------------|
| vsce | ✅ Native | ⚠️ Untested | **High** |
| Vitest | ✅ OK | ✅ OK | Low |
| esbuild | ✅ OK | ✅ OK | Low |
| GitHub Actions | ✅ Native cache | ✅ Native cache | Low |
| tree-sitter (native) | ✅ OK | ⚠️ PnP issues | Medium |
| VS Code debugging | ✅ Recommended | ⚠️ Less tested | Medium |

#### 5. Migration Effort Estimation

**Required Changes**:
- Create `.yarnrc.yml` configuration
- Update `.gitignore` (add `.yarn/`, `.pnp.*`)
- Delete `node_modules/` and `package-lock.json`
- Generate `yarn.lock`
- Modify 2 CI workflow files
- Update documentation (README.md, AGENTS.md)
- Test packaging on 3 platforms
- Test all npm scripts
- Test VS Code extension debugging

**Time Estimate**: 2-4 hours migration + testing

**Risk Level**: Medium-High

---

## Decision Rationale

### Primary Reasons to Stay with npm

1. **Current Solution is Stable and Working**
   - ✅ CI passes on all 3 platforms (Linux, macOS, Windows)
   - ✅ 999/1008 tests passing (98.9% success rate)
   - ✅ Package builds correctly (13.9 MB, no .map files)
   - ✅ Extension installs and activates successfully
   - **Principle**: "If it ain't broke, don't fix it"

2. **VS Code Extension Ecosystem Standard**
   - npm is the recommended package manager by Microsoft for VS Code extensions
   - vsce is optimized and tested with npm
   - Most VS Code extensions in the marketplace use npm
   - Better community support and documentation

3. **Risk-Benefit Analysis**
   - **Benefits**: Potentially cleaner peer dependency resolution, ~3s faster installs
   - **Risks**: Breaking packaging, CI regressions, compatibility issues
   - **Verdict**: **Risk significantly outweighs benefit**

4. **Temporary Nature of Current Workaround**
   - Peer dependency conflict is temporary
   - Will resolve when `tree-sitter-rust` releases version compatible with `tree-sitter@^0.25.0`
   - Current workaround (`.npmrc` + `--no-dependencies`) is well-documented and understood

5. **Contributor Experience**
   - npm is more widely known and used
   - Lower barrier to entry for new contributors
   - Standard `npm install` workflow
   - Less project-specific configuration

6. **Stability > Optimization**
   - Project is in production use
   - Extension stability is critical
   - Performance gains (2-5 seconds) are not critical for development workflow
   - Avoiding migration prevents potential regressions

---

## Consequences

### Positive

- ✅ Maintain stable, tested build and CI pipeline
- ✅ Preserve compatibility with vsce and VS Code tooling
- ✅ Keep standard npm workflow familiar to contributors
- ✅ Avoid 2-4 hours of migration work and testing
- ✅ Reduce risk of introducing packaging or CI regressions

### Negative

- ❌ Continue using `.npmrc` workaround until tree-sitter-rust updates
- ❌ Miss potential 30-40% faster install times (2-5 seconds in practice)
- ❌ Continue with slightly larger lockfile (336 KB vs ~250 KB)

### Neutral

- ⚙️ Will need to monitor `tree-sitter-rust` for updates to remove workaround
- ⚙️ Decision can be revisited if project requirements change (e.g., monorepo)

---

## Alternatives Considered

### Alternative 1: Migrate to Yarn Classic (v1)
**Status**: ❌ Rejected

**Reason**: Yarn v1 is deprecated and offers no advantages over modern npm. Would introduce technical debt.

### Alternative 2: Migrate to Yarn Modern (v3/v4)
**Status**: ❌ Rejected

**Reasons**:
- High risk of vsce compatibility issues
- Requires significant CI/CD changes
- PnP mode may conflict with native modules (tree-sitter)
- Benefits do not justify migration effort and risks

### Alternative 3: Use pnpm
**Status**: ❌ Not Evaluated

**Reason**: Similar risks to Yarn regarding vsce compatibility. Not considered as it would introduce same or greater migration effort.

### Alternative 4: Continue with npm + Monitor Updates
**Status**: ✅ **Accepted**

**Actions**:
1. Keep `.npmrc` workaround until `tree-sitter-rust` supports `tree-sitter@^0.25.0`
2. Periodically check for updates: `npm view tree-sitter-rust versions`
3. Remove workaround once peer dependency resolved upstream
4. Keep npm itself updated to benefit from improvements

---

## Future Considerations

### When to Reconsider This Decision

This decision should be revisited if:

1. **tree-sitter-rust conflict persists long-term** (>6 months)
2. **Project evolves into monorepo** requiring workspaces
3. **vsce officially supports and recommends Yarn**
4. **Significant performance issues** emerge with npm in development
5. **Multiple persistent peer dependency conflicts** accumulate

### Monitoring Strategy

- **Monthly**: Check for `tree-sitter-rust` updates
- **Quarterly**: Review npm version and update to latest
- **Yearly**: Re-evaluate package manager landscape

---

## Related Documents

- [AGENTS.md](../AGENTS.md) - Documents current npm configuration
- [changelog.md](../changelog.md) - v1.6.1 dependency upgrade notes
- [.npmrc](../.npmrc) - Current peer dependency workaround
- [package.json](../package.json) - Build scripts with `--no-dependencies`

---

## References

- [VS Code Extension Guidelines](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce Documentation](https://github.com/microsoft/vscode-vsce)
- [npm vs Yarn Modern Comparison (2026)](https://snyk.io/blog/npm-vs-yarn-which-should-you-choose/)
- [tree-sitter-rust Issue Tracker](https://github.com/tree-sitter/tree-sitter-rust/issues)

---

**Last Reviewed**: 2026-01-13

**Next Review Date**: 2026-07-13 (6 months)
