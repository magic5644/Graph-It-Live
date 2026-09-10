---
paths:
  - "src/analyzer/callgraph/**/*.{ts,tsx}"
  - "src/extension/services/CallGraphViewService.ts"
  - "src/webview/callgraph/**/*.{ts,tsx}"
  - "src/webview/components/cytoscape/**/*.{ts,tsx}"
  - "resources/queries/**/*.scm"
---

# Live Call Graph and WASM

- Keep analyzer call-graph code VS Code-agnostic.
- Map `CallGraphEdge` before cycle detection: `edges.map(e => ({ source: e.sourceId, target: e.targetId }))`.
- Cytoscape visibility uses collection APIs: reset with `cy.elements().removeStyle("display")`, then set collection `display`; do not call nonexistent singular-node `hide()`/`show()`.
- Call-graph panel loads `dist/callgraph.js`, never `dist/webview.js`.
- Keep sql.js at `dist/wasm/sqljs.wasm`; preserve runtime `locateFile` resolution through extension URI.
- Keep language queries under `resources/queries/` and copy them to `dist/queries/` during build.
- After WASM/query/build changes, build, package, verify assets in VSIX, and test extension activation.
