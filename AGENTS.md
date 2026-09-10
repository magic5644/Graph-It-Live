# Graph-It-Live Agent Guide

VS Code extension, standalone CLI, and MCP server for dependency and call-graph analysis. Requires Node.js 22+ and npm.

## Commands

- Build: `npm run build`; one test: `npx vitest run <test-file>`; unit suite: `npm test`.
- Quality: `npm run lint`, `npm run check:types`, `npm run test:coverage`; E2E: `npm run test:vscode`.
- Package: `npm run package && npm run package:verify`.

Prefix shell commands with `rtk`; use `rtk proxy <command>` when no optimized wrapper exists.

## Universal Rules

- Keep `src/analyzer/**` and `src/mcp/**` Node.js-only: never import `vscode`.
- Define extension↔webview messages in `src/shared/types.ts`; update sender and receiver together.
- Build paths with `node:path`; call `normalizePath()` before path keys enter Sets or Maps.
- Keep TypeScript strict. Avoid `any`; ESLint decides style.
- New functions/modules need success and edge/failure unit tests. User-facing behavior also needs VS Code E2E coverage. Touched files must stay at or above 80% coverage.
- Never delete empty maps eagerly in `ReverseIndex.removeDependenciesFromSource()`; cleanup is query-time to avoid re-index races.
- Build/dependency/package changes require production package validation: zero `.map` files and required WASM/query assets present.
- After source changes, run targeted tests, lint, typecheck, and configured SonarQube analysis; fix findings caused by change.

## Working Method

- Understand full flow and callers before editing. Fix root cause once.
- Prefer deletion, existing helpers, standard library, platform features, and installed dependencies—in that order. Add no abstraction or dependency without need.
- Make smallest complete diff; preserve unrelated code and APIs.
- For architecture, impact, or relationship questions, query `graphify-out/graph.json` with `graphify query`, `graphify explain`, or `graphify path` before broad file scans. Run `graphify update .` after source changes.

## Detailed / Conditional Instructions

Before modifying matching paths—or when task topic matches—read corresponding rule:

| Scope or task | Rule |
| --- | --- |
| Any `src/**` architecture or code-style change | `.claude/rules/architecture.md` |
| Analyzer, MCP, shared security, paths | `.claude/rules/analyzer-mcp-security.md` |
| React/webview | `.claude/rules/webview-react.md` |
| Tests or coverage | `.claude/rules/testing.md` |
| Build, dependencies, package, WASM | `.claude/rules/build-packaging.md` |
| Live call graph or Cytoscape | `.claude/rules/callgraph-wasm.md` |
| Markdown or Mermaid diagrams | `.claude/rules/documentation-diagrams.md` |
| AIDD agents, gates, memory, handoffs | `.claude/rules/agent-workflow.md` |
| Broad-task bootstrap, shell use, exploration, refactoring, codemaps | `.claude/rules/development-workflow.md` |
| Source changes or SonarQube | `.claude/rules/quality-gates.md` |

Claude Code and VS Code load matching `.claude/rules` automatically. Codex must follow routing table explicitly.

## Custom Agents and Automation

- AIDD personas: `.claude/agents/`; orchestration commands: `.claude/commands/`; workflow: `.claude/FRAMEWORK.md`.
- Reusable repository agents: `.agents/agents/`; VS Code agents: `.github/agents/`.
- Focused validation skills: `graph-it-live-layer-check`, `graph-it-live-package-validator`, and `graph-it-live-wasm-verify`.
