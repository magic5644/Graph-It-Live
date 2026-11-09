# Graph-It-Live CLI command reference

Read on demand from the `graph-it-live` skill. Options below were checked against `graph-it --help`
and `graph-it <command> --help`. Confirm with that help when the installed version differs.

## Workspace root

Imports that resolve outside the workspace root are skipped. Without `--workspace`, the CLI uses the
nearest directory, from the current one upward, holding a project marker of a supported language
(`package.json`, `tsconfig.json`, `jsconfig.json`, `deno.json(c)`, `pyproject.toml`, `setup.py`,
`setup.cfg`, `requirements.txt`, `Pipfile`, `Cargo.toml`, `go.mod`, `go.work`, `pom.xml`,
`build.gradle(.kts)`, `settings.gradle(.kts)`, `*.csproj`, `*.sln`, `*.slnx`,
`Directory.Build.props`). Outside any project (a home directory, `/`) it exits with code `3` before
reading a file. `graph-it -w <dir>` forces the root: it is used exactly as given, marker or not, and
`.graph-it/` (index + cache) is created there.

For impact, dependents and cross-package questions in a monorepo, pass the monorepo root with
`graph-it -w <monorepoRoot> ...` instead of `cd` into a package. If `scan` warns that imports resolve
outside the workspace root, answers cover that root only (`graph-it tool get_index_status` reports
`outOfRootImports` and `monorepoRoot`): rerun with the `--workspace` it names or state the limitation.

Global flags: `--reindex` discards the cached index and rebuilds it; `--no-cache` neither reads nor
writes the cache (also `GRAPH_IT_NO_CACHE=1`).

## Bounded graph context

```bash
graph-it context "how does authentication reach the database" --mode search --scope 'src/**' --depth 2 --detail compact --token-budget 2000 --format toon
graph-it context --mode impact --seeds 'src/api.ts#handle' --relations CALLS --depth 3 --detail compact --token-budget 4000 --format toon
graph-it context --from 'src/api.ts#handle' --to 'DatabasePool' --mode path --detail compact --format toon
```

- `--mode`: `search|neighbors|path|impact|refactor|overview`.
- `--seeds` (repeatable) and `--from`/`--to` take `file#symbol` or `symbol`.
- `--relations` (repeatable, e.g. `CALLS`, `IMPORTS`), `--scope <glob>`, `--depth 1-5`,
  `--max-nodes 1-500`, `--token-budget 500-16000`, `--directed`, `--detail compact|standard|full`.
- `truncated=true` returns `nextCursor` and `omitted` counts. See "Budgets and complete results" below.

### Budgets and complete results

Every CLI call costs a turn and an index load, so size the budget to answer in one call:

1. Pick the budget for the task: about 2000 to locate code, 4000-8000 for impact or refactor, 16000 at most.
2. On `truncated=true`, stop if the seeds and top-ranked nodes already answer.
3. Otherwise narrow the request (`--scope`, `--seeds`, `--relations`, `--depth`): cheaper than reading more.
4. When every result is needed (importers before a refactor, all callers before a deletion), rerun once
   with `--token-budget 16000`; page with `--cursor <nextCursor>` only if that is still truncated.
   Pages do not repeat nodes.
5. `--mode search` ranks the whole graph: never page it to the end.

`query_call_graph --tokenBudget=0` returns every caller in one call; with a budget, pass `nextOffset`
as `--offset`. `get_impact_analysis` has no budget and returns the whole result.

`graph-it query "<question>"` (`--depth`, `--token-budget`, `--format text|json|toon`) answers in
natural language. It uses `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` when set and falls back to keyword
heuristics with a stderr warning. Treat its answer as a hypothesis; confirm with deterministic
commands.

## Files and symbols

```bash
graph-it summary --format toon                  # workspace overview
graph-it summary src/api.ts --format toon       # per-file codemap: exports, internals, dependencies, dependents, call flow, cycles
graph-it explain src/server.ts --format toon    # intra-file call hierarchy: entry points, call tree, internal cycles
graph-it trace src/index.ts#main --format toon  # call chain from <file>#<symbol>, relative or absolute path
graph-it path src/index.ts --format toon        # transitive imports from an entry file (--communities path|louvain)
graph-it path-in src/index.ts --format toon     # who imports this file
graph-it check-dependencies src/index.ts --format toon   # incoming and outgoing dependencies
graph-it cycles src/index.ts --format toon      # confirmed dependency cycles for a file
graph-it check src/api.ts --format toon         # unused exports of one file
```

## `graph-it tool <name>`

`graph-it tool <name>` invokes an analysis tool directly; `graph-it tool <name> --help` lists its
parameters. Pass `--<param>=<value>` or `--<param> <value>`; arrays and objects are JSON;
`--args '<json>'` passes the whole object. Path parameters are documented as absolute; workspace-
relative paths are also resolved. Inventory checked with `graph-it tool --list`:

`graph_context`, `analyze_dependencies`, `crawl_dependency_graph`, `find_referencing_files`,
`verify_dependency_usage`, `resolve_module_path`, `get_index_status`, `invalidate_files`,
`rebuild_index`, `get_symbol_graph`, `find_unused_symbols`, `trace_function_execution`,
`analyze_breaking_changes`, `get_impact_analysis`, `generate_codemap`, `query_call_graph`,
`scan_dead_code`, `explore_architecture`, `check_architecture`.

```bash
graph-it tool analyze_dependencies --filePath=/abs/src/a.ts --format toon
graph-it tool find_referencing_files --targetPath=/abs/src/a.ts --format toon
graph-it tool verify_dependency_usage --sourceFile=/abs/src/b.ts --targetFile=/abs/src/a.ts --format toon
graph-it tool generate_codemap --filePath=/abs/src/a.ts --format toon
graph-it tool query_call_graph --filePath=/abs/src/a.ts --symbolName=fn --direction=callers --depth=1 --tokenBudget=2000 --format toon
graph-it tool get_impact_analysis --filePath=/abs/src/a.ts --symbolName=fn --includeTransitive=true --maxDepth=3 --format toon
graph-it tool find_unused_symbols --filePath=/abs/src/a.ts --format toon
graph-it tool scan_dead_code --scopePath=/abs/src --maxFiles=500 --format toon
graph-it tool analyze_breaking_changes --args '{"filePath":"/abs/src/a.ts","symbolName":"fn","oldContent":"...","newContent":"..."}' --format toon
```

- `query_call_graph`: `--direction callers|callees|both` (default both), `--depth 1-10` (default 2),
  `--includeTypeOnly=true` adds type-only `USES` edges, `--tokenBudget` (default 4000, `0` = no limit) with `--offset <nextOffset>` paging.
  A bare name shared by several symbols returns `reason=ambiguous` with candidates; pick one with
  `--symbolId` or `--startLine`. Call sites are not all symbol references.
- `get_impact_analysis`: `--includeTransitive` (default false), `--maxDepth 1-20` (default 3).
- `scan_dead_code` is workspace-wide (or `--scopePath`); `find_unused_symbols` and `graph-it check`
  are per-file.

## Architecture

```bash
graph-it architecture --level units --format toon              # packages (else top-level folders), layers, unit edges, cycles
graph-it architecture --groups --format toon                   # folder groups, groupEdges, totals
graph-it architecture --folder "(root)/src" --format toon      # one level below a unit or folder key
graph-it architecture --level units --from apps/web --to packages/core --format toon   # file pairs behind a unit edge
graph-it architecture --level units --matrix --format toon     # dependency structure matrix (--format csv only for a spreadsheet export)
graph-it architecture --maxFiles 300 --format toon             # cap analyzed files on a large workspace
```

Step by step instead of the whole graph: `graph-it tool explore_architecture` (summary), then
`--group=<key>` (files and boundary), then `--from=<key> --to=<key>` (file pairs, paged by
`--limit`/`--offset`). It returns TOON by default (`--response_format`).

When `graphit.architecture.json` declares rules, `graph-it check-architecture --format toon` checks
every static import. It exits 1 on an `error` violation absent from
`graphit.architecture.baseline.json`; `--update-baseline` accepts the current violations, `--verbose`
lists accepted ones, `--config`/`--baseline` pick other files, `--format sarif` feeds code scanning.

## Diagrams for humans (CLI 1.23.0 or later)

```bash
graph-it diagram --format svg --rules --output docs/architecture.svg
graph-it diagram --format diagram-spec --output -
```

`graph-it diagram` writes a static, script-free SVG or HTML file of the units, one folder
(`--folder <key>` or a `[dir]` argument) or their matrix (`--view matrix`); `--theme light|dark` for
SVG. `--rules` draws violations in red; `--baseline` draws accepted ones apart. The file stays inside
the workspace; `--output -` prints it.

For a polished or branded diagram, pass the `diagram-spec` JSON (add `--rules`, `--folder <key>`) to
an available diagram skill (`diagram-design`, `architecture-diagram`, `archify`). The spec lists every
node (label, layer, file count, role), layers, weighted edges, cycles, broken rules and caption lines
(`schemas/diagram-spec.schema.json`). Draw only listed nodes and edges and keep their counts. Older
CLIs: use `graph-it architecture --groups --format json` and its `groups`, `groupEdges`, `context`.
Runtime flows come from `graph-it trace` and are static analysis, not observed execution.

Mermaid for a human: `graph-it trace <file>#<symbol> --format mermaid`, `graph-it path <file> --format
mermaid`, `graph-it architecture --groups --format mermaid`.

## Other commands

```bash
graph-it wiki --output docs/wiki --top 15     # markdown wiki from the call graph (--scope, --exclude, --force)
graph-it export src/analyzer --format html --output analyzer.html   # standalone HTML graph
graph-it stats                                # session token stats, estimated with the cl100k_base tokenizer
```

## Review a diff

`graph-it review-pr --base <ref>` indexes automatically (no `scan` first). Without `--head` it compares
the base with the working tree, staged and unstaged included; `--head <ref>` compares two committed
refs. `--depth 1-10`, `--max-files 1-1000`, `--format toon|json|markdown|sarif`.

Read `risk`, `score`, `limitations` and `isPartial` before any merge recommendation. `isPartial: true`
means file, parser or depth limits cut the result. No breaking signature does **not** prove a
behavioural change is safe. Use the `pr-review` skill for the full workflow and the GitHub Actions gate.
