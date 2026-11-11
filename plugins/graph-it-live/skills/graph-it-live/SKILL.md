---
name: graph-it-live
description: |
  Analyze code dependencies, call graphs, and architecture using the graph-it CLI. Use this skill
  whenever the user wants to understand how their code is connected — even if they don't say
  "dependency graph" explicitly. Trigger for: "what calls this function", "who uses this class",
  "is it safe to delete X", "what breaks if I change Y", "show me the architecture", "trace the
  execution from main", "find circular imports", "give me an overview of this module", "what imports
  this file", "impact analysis", "review this PR", "review this diff",
  "is this change risky", breaking changes, unused exports, dead code detection, codemap, file logic,
  module resolution, graph-it, dependency graph, reverse dependencies.
argument-hint: 'What do you want to analyze in your codebase?'
context: fork
---

# Graph-It-Live

Dependency, call-graph, impact and architecture analysis through the `graph-it` CLI. Supported
languages: TypeScript, JavaScript, Python, Rust, C#, Go, Java, Vue, Svelte, GraphQL.

## Route the task first

| Task | First step |
| --- | --- |
| The file or symbol is already known (read it, explain it, edit one place) | Read it directly and bounded (the symbol's line range, or `offset`/`limit`). No graph call. |
| Locate code by behaviour or concept | `graph-it context "<question>" --mode search --detail compact --token-budget 2000 --format toon` |
| Callers, importers, impact, "safe to delete or change?" | Graph first: `path-in`, `query_call_graph --direction=callers`, `get_impact_analysis` |
| Architecture, cycles, module overview | Graph first: `architecture --level units`, `cycles`, `summary <file>` |
| A diff or pull request | `review-pr`; use the **pr-review** skill |

After a graph step, read only the files and line ranges it names. Text search locates; it does not
prove callers or impact.

## Setup and discovery

- Prefer the CLI when it and a terminal are available. At the first activation of any Graph-It skill
  in a session, run `graph-it --version` and `graph-it tool --list` once; share them across Graph-It
  skills and refresh only when the CLI, version, server or workspace changes or a tool is unknown.
  Read `graph-it <command> --help` or `graph-it tool <name> --help` only for a flag you need.
- Requires CLI **1.21.0 or later** (`graph-it diagram`: 1.23.0). Older or unreadable version: say so
  once, name the missing commands, offer `graph-it update`, and use only what that CLI's `--help` and
  `tool --list` show. Never present output from a command the CLI lacks as a result.
- Never install the CLI automatically; on an explicit request, see `references/setup.md`.
- Update consent: when the CLI reports a newer version, run `graph-it update` only after explicit
  positive confirmation. Silence, timeout, refusal, non-TTY and generic Agent mode are not consent; an
  explicitly pre-authorized automatic mode is. After success, refresh version and inventory; a running
  MCP server needs a host-authorized restart. On failure, keep a usable CLI, warn once, do not retry.
- MCP is the fallback when the CLI is unavailable: use only tools, namespaces and parameters the host
  advertises. `graph-it tool <name>` calls analysis directly; `graph-it serve` starts the MCP server.

## Output format

Use `--format toon` for every output the agent reads, with `--detail compact` and `--token-budget N`
on `context` (`--token-budget` on `query`, `--tokenBudget` on `query_call_graph`). Use `json` only when
a script parses the output, and `markdown` or `mermaid` only when the output itself goes to a human.
Size the budget to answer in one call (about 2000 to locate, 4000-8000 for impact, 16000 at most). On
`truncated=true`, stop if the top results answer. Otherwise narrow with `--scope`/`--seeds`, or, when
every result is needed, rerun once at `--token-budget 16000`, then page with `--cursor <nextCursor>`.
`query_call_graph --tokenBudget=0` returns all callers in one call.
MCP `response_format` is a separate parameter (TOON by default on current servers); pass it only when
the schema advertises it.

## Core commands

```bash
graph-it -w <monorepoRoot> path-in src/a.ts --format toon  # cross-package questions: run from the monorepo root
graph-it context "<question>" --mode search --detail compact --token-budget 2000 --format toon
graph-it context --mode impact --seeds 'src/a.ts#fn' --depth 3 --detail compact --token-budget 4000 --format toon
graph-it summary src/a.ts --format toon          # codemap: exports, dependencies, dependents, call flow
graph-it path-in src/a.ts --format toon          # who imports this file
graph-it tool query_call_graph --filePath=/abs/src/a.ts --symbolName=fn --direction=callers --depth=1 --format toon
graph-it tool get_impact_analysis --filePath=/abs/src/a.ts --symbolName=fn --includeTransitive=true --format toon
graph-it trace src/index.ts#main --format toon   # execution chain; --format mermaid for a human
graph-it architecture --level units --format toon
graph-it cycles src/a.ts --format toon
graph-it check src/a.ts --format toon            # unused exports of one file
graph-it review-pr --base origin/main --format toon
```

Every command indexes on demand and re-analyzes only changed files: no `graph-it scan` first, none
after edits. `--reindex` rebuilds from scratch when results look wrong. If a command warns that
imports resolve outside the workspace root, results cover that root only: rerun
with the `--workspace` it names or state the limitation. Outside any project the CLI exits with code 3.

## Read on demand

- `references/commands.md`: every command and option (workspace root markers, `context` modes and
  paging, `tool` parameters, architecture levels and matrix, `check-architecture`, `diagram` and
  `diagram-spec`, `wiki`, `export`, `stats`, `review-pr` fields).
- `references/setup.md`: installation, MCP client configuration, VS Code extension.

## Never

- Run `graph-it scan` before analysis or after edits: commands index themselves.
- Assume a tool or parameter exists because an example shows it; check `tool --list` and help.
- Pass CLI flags to MCP unless its input schema advertises them.
- Present caller results as all references, or static evidence as proof of runtime behaviour.

## Related skills

- **dead-code-hunter**: project-wide, safety-ranked deletion plan.
- **onboarding-express**: structured tour (entry points, business logic, most complex module).
- **pr-review**: review a Git diff locally or in GitHub Actions.
- **graph-it-refactor**: map, edit and verify a multi-file refactor.
- **skill-manager**: list or uninstall installed skills.
