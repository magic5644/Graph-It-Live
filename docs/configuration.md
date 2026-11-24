# Configuration

## Branch Watch

Branch Watch is disabled by default. Enable `graph-it-live.branchWatch.enabled` for a workspace folder, select a local Git base branch and optionally a local or remote head branch, and use the native Branch status view to inspect changes automatically (it starts collapsed in the Graph-It-Live panel: expand it, or run `Graph-It-Live: Show Branch Status`). Branch selections are stored per workspace in the ignored `.graph-it/branch-watch.json`; the `baseRef` and `headRef` settings are retained only as a legacy fallback. An empty head, or a head equal to the checked-out branch, uses the current branch plus the final on-disk state; another head branch compares committed branch refs and does not include untracked workspace files. It never fetches, runs tests, or reports test success. The view shows file impact for supported languages, the same signature review as `graph-it review-pr` (TypeScript, JavaScript, Vue and Python, deleted files included, an unreadable file reported as a limitation), the import cycles the changes introduce, aggravate or touch, and explicit limitations. Cycles are read from the whole import graphs, as `graph-it review-pr` reads them: the head from the warmed index (nothing is parsed again on a file event) and the merge base from a private Git copy, parsed once per merge-base commit and reused until the base moves. On each file event, only the edited files are compared again; importers and consumers are always read fresh. Impact traversal is intentionally bounded (depth 3 and at most `graph-it-live.branchWatch.maxFiles` files, 200 by default), so a partial result is reported with its risk and confidence instead of being presented as complete. Right-click any message row and choose `Copy Message` to pass the exact text to an LLM or issue. The reminder `Tests must pass before delivery.` is informational.

Branch Watch requires the Graph-It-Live workspace root to be a supported Git repository. A folder without Git, an unborn or detached repository, conflicts, an inaccessible index, or an unsupported VCS is shown as `Branch watch unavailable`; the normal graph and CLI/MCP tools remain available.

Set these options in VS Code settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `graph-it-live.branchWatch.enabled` | `false` | Enable Branch Watch for the workspace folder |
| `graph-it-live.branchWatch.maxFiles` | `200` | Limit the changed files Branch Watch analyzes and the files its impact walk visits; cycles are not bounded |
| `graph-it-live.performanceProfile` | `default` | Select `default`, `low-memory`, `high-performance`, or `custom` |
| `graph-it-live.enableMcpServer` | `false` | Enable the built-in MCP server |
| `graph-it-live.maxDepth` | `50` | Limit dependency traversal depth |
| `graph-it-live.excludeNodeModules` | `true` | Exclude dependencies from `node_modules` |
| `graph-it-live.ignoreTypeImports` | `false` | Hide the edges whose every import is type-only (`import type`, Python `if TYPE_CHECKING:`); applies at once, impact analysis and dependents still count them |
| `graph-it-live.enableBackgroundIndexing` | `true` | Build reverse-dependency indexes in the background |
| `graph-it-live.unusedDependencyMode` | `hide` | Hide or dim unused dependencies |
| `graph-it-live.communityMode` | `path` | Group graph communities by folder (`path`) or by import structure (`louvain`); same as CLI `--communities` |
| `graph-it-live.preIndexCallGraph` | `true` | Pre-index the Live Call Graph |

Workspace indexing (extension, CLI, and MCP) skips paths listed in the root `.gitignore`, plus `tests/fixtures/` and `out-*/` by default. Add a root `.graphitignore` with gitignore syntax to exclude more paths, or negate a rule to include it again, for example `!tests/fixtures/`.

`performanceProfile` sets indexing concurrency, cache sizes, and unused-analysis limits. To tune them by hand, select `custom` and edit the **Advanced: Performance overrides** section (search `@tag:advanced graph-it-live` in the Settings editor). The other profiles ignore these overrides. Cache sizes, unused-analysis values, `preIndexCallGraph` and `indexingStartDelay` apply after a window reload; `workspaceFolder` moves the MCP server at once and the graph view after a reload.
