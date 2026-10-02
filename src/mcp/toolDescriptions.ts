/**
 * Tool descriptions - single source of truth for the MCP server, the
 * `graph-it tool --list` summaries and the VS Code Language Model tool
 * `modelDescription` fields in package.json.
 *
 * Each description is a one-sentence summary followed by labelled lines.
 * A plain string line is shared by every surface. A `{ mcp, lm }` line differs
 * per surface because the LM tools are implemented separately
 * (src/extension/services/LmToolsService.ts) with smaller input schemas and no
 * tokenBudget paging; a surface whose key is absent omits the line.
 *
 * Tool names are written with the MCP prefix (`graphitlive_`); the LM text
 * rewrites them to the LM prefix (`graph-it-live_`).
 *
 * package.json is regenerated with `npm run sync:tool-descriptions`;
 * tests/mcp/toolDescriptions.test.ts fails when it drifts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { McpToolName } from "./types";

type DescriptionLine = string | { mcp?: string; lm?: string };

interface ToolDescription {
  summary: string;
  lines: DescriptionLine[];
}

export type DescribedToolName = McpToolName | "get_session_stats";

const OPEN_ENDED_HINT =
  "For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.";
const TOKEN_BUDGET_LIMIT =
  "output capped by tokenBudget (default 4000, 0 = no limit); a cut sets truncated=true, omitted counts and nextOffset - pass it as offset to read the rest.";
const LM_CALL_GRAPH_INDEX =
  "needs the call graph index, built in the background when the Graph-It-Live view first loads (graph-it-live.preIndexCallGraph) or when the Call Graph panel opens; until then the tool returns an error.";

const TOOL_DESCRIPTIONS: Record<DescribedToolName, ToolDescription> = {
  set_workspace: {
    summary: "Points this server session at the project root the other tools analyse.",
    lines: [
      "WHEN: once per session, as setup before the first analysis. The root resolved at startup comes from WORKSPACE_ROOT or the working directory the client happened to spawn the server in, so it is often absent or points at the wrong project. Call this again during a session only to switch projects, or to reach a path outside the current root (paths outside it are rejected).",
      "NOT THIS TOOL: it is setup, and answers no question about code. It is never the reply to a question about architecture, callers, dependencies, dead code or documentation - once the root is set, call the tool that answers the question. One call holds for the whole session; repeating it re-indexes for nothing.",
      "RETURNS: resolved workspace path, number of files indexed, indexing duration.",
    ],
  },
  graph_context: {
    summary:
      "Returns a token-bounded subgraph answering a question about the codebase - the default entry point for graph questions.",
    lines: [
      "WHEN: any question spanning file dependencies, symbol calls, implementations, tests or impact; reach for a specialised tool only when this cannot express the cut you need.",
      "WHY: one deterministic gateway over the same index the specialised tools use, with an explicit token budget so large graphs come back bounded instead of truncated arbitrarily.",
      "MODES: search, neighbors, path, impact, refactor, overview.",
      "RETURNS: nodes and edges with workspace-relative paths, an index revision and a freshness flag, and a cursor when results are paginated.",
      { lm: `LIMITS: ${LM_CALL_GRAPH_INDEX}` },
    ],
  },
  analyze_dependencies: {
    summary:
      "Lists the import/export statements of one file, with each specifier resolved to a path on disk.",
    lines: [
      `WHEN: "what does this file import", "what are this file's dependencies".`,
      "WHY: read from the parsed source, so tsconfig path aliases, implicit extensions and index files are already resolved.",
      {
        mcp: "RETURNS: per statement - module specifier, resolved absolute path, workspace-relative path, import type (static, dynamic, require, re-export), line number.",
        lm: "RETURNS: one entry per resolved workspace file - module specifier, workspace-relative path, import type (import, require, export, dynamic), line number. Unresolved and external imports are left out.",
      },
      "SUPPORTS: TypeScript, JavaScript, Vue, Svelte, GraphQL.",
    ],
  },
  crawl_dependency_graph: {
    summary: "Builds the transitive file dependency graph reachable from one entry file.",
    lines: [
      {
        mcp: "WHEN: project architecture, full dependency tree from an entry point, circular-import detection.",
        lm: "WHEN: project architecture, full dependency tree from an entry point.",
      },
      "WHY: crawls real import edges across the workspace rather than inferring structure from file names.",
      {
        mcp: "RETURNS: nodes (path, extension, dependency count, dependent count, circular flag) and edges (import relations); paginated via offset/limit.",
        lm: "RETURNS: nodes (workspace-relative path) and edges (import relations, source and target). maxDepth defaults to the configured graph-it-live.maxDepth, else 3.",
      },
      { mcp: `LIMITS: ${TOKEN_BUDGET_LIMIT}` },
      OPEN_ENDED_HINT,
    ],
  },
  find_referencing_files: {
    summary:
      "Lists every file that imports or references a given file (reverse dependency lookup).",
    lines: [
      `WHEN: impact analysis, "who uses this file", refactoring-safety checks before changing or deleting a file.`,
      "WHY: served from a prebuilt reverse index, so it covers the whole workspace rather than the files already in context.",
      {
        mcp: "RETURNS: absolute and workspace-relative path of each referencing file.",
        lm: "RETURNS: workspace-relative path, import type, line and module specifier of each referencing file.",
      },
      OPEN_ENDED_HINT,
    ],
  },
  expand_node: {
    summary:
      "Returns the dependencies of one file that are not already in a set of paths you provide.",
    lines: [
      "WHEN: exploring a large graph incrementally, or lazily loading one node at a time.",
      {
        mcp: "WHY: skips re-analysing what you already hold, so only newly discovered files come back.",
        lm: "WHY: crawls the file's transitive dependencies and drops what you already hold, so only newly discovered files come back.",
      },
      "RETURNS: the new nodes and edges only, with the same fields as crawl_dependency_graph.",
      { mcp: `LIMITS: ${TOKEN_BUDGET_LIMIT}` },
    ],
  },
  parse_imports: {
    summary: "Returns the import statements of one file: module specifier, import type and line.",
    lines: [
      {
        mcp: "WHEN: inspecting import style or alias usage, or debugging why a specifier fails to resolve.",
        lm: "WHEN: inspecting import style or alias usage, without the resolved paths.",
      },
      {
        mcp: "WHY: regex-based, and extracts the script block from Vue/Svelte files first.",
        lm: "WHY: uses the language-aware parser pipeline, so it is more accurate than a text search.",
      },
      "RETURNS: module specifier as written, import type, line number.",
      {
        mcp: "LIMITS: does not resolve paths - use graphitlive_analyze_dependencies for resolved targets.",
        lm: "LIMITS: lists only imports that resolve to a workspace file, once per file - use graphitlive_resolve_module_path to debug one that does not.",
      },
    ],
  },
  verify_dependency_usage: {
    summary: "Reports whether a source file actually uses any symbol from a target file it imports.",
    lines: [
      "WHEN: identifying unused imports, or confirming a dependency edge is real before acting on it.",
      "WHY: AST analysis of actual references, so an import that is never used is distinguished from one that is.",
      "RETURNS: boolean.",
    ],
  },
  resolve_module_path: {
    summary: "Resolves one module specifier, as seen from a given file, to a path on disk.",
    lines: [
      `WHEN: "where does this import point", or debugging alias and extension resolution.`,
      "WHY: applies tsconfig path aliases, implicit extensions (.ts, .tsx, .js, .jsx, .vue, .svelte, .gql) and index-file resolution.",
      {
        mcp: "RETURNS: resolved absolute path and whether it lies inside the workspace, or null for an unresolvable or external module.",
        lm: "RETURNS: whether resolution succeeded and the resolved workspace-relative path.",
      },
    ],
  },
  get_index_status: {
    summary: "Reports the state of the dependency index backing the other tools.",
    lines: [
      "WHEN: checking readiness before a large analysis, or explaining unexpectedly empty results.",
      `WHY: distinguishes "no results" from "index not built yet".`,
      {
        mcp: "RETURNS: index state, files indexed, reverse-index statistics, cache size and hit rate, warmup completion and duration.",
        lm: "RETURNS: index state, readiness flag, whether the reverse index exists, cache size and reverse-index statistics (files indexed included).",
      },
    ],
  },
  invalidate_files: {
    summary: "Drops the cached analysis for specific files so the next query re-reads them.",
    lines: [
      {
        mcp: "WHEN: after editing files outside the watched workspace, when results look stale.",
        lm: "WHEN: results look stale after edits the file watcher missed. Paths must lie inside an open workspace folder.",
      },
      "WHY: analysis is cached per file; the cache is otherwise refreshed by the file watcher.",
      {
        mcp: "RETURNS: how many files were invalidated, which were cleared, and which held no cache entry. The call graph re-extracts these files on the next graph query.",
        lm: "RETURNS: how many files were invalidated, which were cleared, and which held no cache entry.",
      },
    ],
  },
  rebuild_index: {
    summary: "Clears all cached analysis and re-indexes the whole workspace.",
    lines: [
      "WHEN: after a branch switch or large refactor when the index no longer matches the tree; invalidate_files is enough for a few files.",
      "WHY: restores a graph that is consistent with what is on disk.",
      {
        mcp: "RETURNS: files re-indexed, duration, new cache size, reverse-index statistics, and the call graph rebuilt from scratch (files, symbols, relations) or why it could not be.",
        lm: "RETURNS: rebuild duration and new cache size.",
      },
      "LIMITS: takes seconds on a large workspace.",
    ],
  },
  get_symbol_graph: {
    summary:
      "Lists the symbols a file exports and the symbols OUTSIDE the file that each of them depends on.",
    lines: [
      `WHEN: "which function in this file calls the database / uses X", scoping a refactor to one symbol rather than the whole file.`,
      "WHY: ts-morph AST parsing, so import aliases are tracked back to their original names and type-only imports are separated from runtime ones.",
      {
        mcp: "RETURNS: exported symbols (name, kind, line, category) and symbol-to-symbol edges tagged runtime or type-only.",
        lm: "RETURNS: every symbol of the file (name, kind, line, category, internal ones included) and symbol-to-symbol edges tagged runtime or type-only.",
      },
      "NOT THIS TOOL: for calls between symbols defined in the same file, use graphitlive_generate_codemap (its call flow section). This tool crosses the file boundary outward; that one stays inside it.",
      OPEN_ENDED_HINT,
    ],
  },
  find_unused_symbols: {
    summary: "Lists the symbols a file exports that nothing else in the workspace imports.",
    lines: [
      "WHEN: dead-code cleanup in one file, or checking which parts of an API are consumed.",
      "WHY: cross-references the file's exports against the reverse index, then widens the used set through the file's internal call graph so a symbol reached only indirectly is not reported.",
      "RETURNS: unused exported symbols (name, kind, line, category), unused and total counts, unused percentage.",
      "LIMITS: an export reached only through a dynamic or string-keyed lookup can still be reported as unused; confirm before deleting.",
    ],
  },
  get_symbol_dependents: {
    summary:
      "Lists the symbols that use one given symbol - one hop, computed from source at call time.",
    lines: [
      "WHEN: changing a signature and needing every call site, or assessing the blast radius of a symbol-level change.",
      {
        mcp: "WHY: re-reads the referencing files instead of a cached index, so it reflects edits the index has not absorbed yet.",
        lm: "WHY: walks the symbol graphs of every file that references the target, so file-level imports count as well as calls.",
      },
      "RETURNS: caller symbol id, file path and workspace-relative path per dependent, plus a total count.",
      "PICKING BETWEEN THE THREE: this one for every reference, including file-level imports, computed fresh; graphitlive_get_symbol_callers for call sites only; graphitlive_query_call_graph for multi-hop traversal, callees, or relation types.",
    ],
  },
  trace_function_execution: {
    summary: "Follows the call chain outward from one symbol, recursively, across files.",
    lines: [
      "WHEN: tracing a request through controller, service and repository, or mapping what a feature actually reaches.",
      "WHY: follows calls through multiple files instead of stopping at direct dependencies; stops at external modules, at maxDepth, or on a cycle.",
      "RETURNS: root symbol, call chain entries (depth, caller, callee, resolved path), visited symbols, and whether maxDepth was hit.",
      OPEN_ENDED_HINT,
    ],
  },
  get_symbol_callers: {
    summary: "Lists the call sites of one given symbol - one hop, from the call graph index.",
    lines: [
      `WHEN: the plain question "who calls X"; finding call sites before a rename; spotting a symbol with no callers.`,
      "WHY: reads CALLS edges from the indexed call graph, so it returns only symbols that call X. File-level imports and other references are not callers; use graphitlive_get_symbol_dependents for those.",
      {
        mcp: "RETURNS: one entry per caller symbol with file path, workspace-relative path, line of the first call and usage type. Type-only references are added only with includeTypeOnly.",
        lm: "RETURNS: one entry per caller symbol with workspace-relative path, line of the first call and a type-only flag, plus runtime and type-only counts. Type-only references are added only with includeTypeOnly. The source field says whether the call graph or the symbol dependents fallback answered (the call graph is used once indexed; line is null in the fallback).",
      },
      "PICKING BETWEEN THE THREE: this one for call sites; graphitlive_get_symbol_dependents for every reference (imports included) computed fresh from source; graphitlive_query_call_graph when you need more than one hop, callees as well as callers, or relation types such as INHERITS and IMPLEMENTS.",
    ],
  },
  analyze_breaking_changes: {
    summary: "Compares two versions of a file and reports which signature changes break callers.",
    lines: [
      "WHEN: validating an edit before committing, or writing migration notes for an API change.",
      "WHY: diffs the parsed signatures rather than the text, so added optional parameters are separated from breaking ones.",
      {
        mcp: "RETURNS: breaking changes with kind and description, severity, suggested migration steps, and the callers that need updating.",
        lm: "RETURNS: breaking changes (type, symbol, description, severity, old and new value, line) and non-breaking changes. Without newContent the current file on disk is used.",
      },
      {
        mcp: "DETECTS: added required parameter, removed parameter, changed parameter type, changed return type, parameter reordering.",
        lm: "DETECTS: added required parameter, removed parameter, changed parameter or return type, optional made required, reduced visibility, removed or changed interface member, changed type alias.",
      },
    ],
  },
  review_pr: {
    summary: "Reviews a local Git diff and reports the risk it carries, with per-symbol evidence.",
    lines: [
      "WHEN: before opening a pull request, or as a CI gate.",
      "WHY: combines the parsed signatures of both revisions with the workspace index, so signature changes are scored against their real callers.",
      "RETURNS: deterministic risk level, per-symbol evidence, impact counts, and an explicit list of what could not be analysed.",
      { lm: "LIMITS: runs git in the first workspace folder; impact counts are incomplete while background indexing runs." },
    ],
  },
  get_impact_analysis: {
    summary: "Reports everything affected by changing one symbol, direct and transitive.",
    lines: [
      "WHEN: assessing a refactor before starting it, or prioritising which call sites to update first.",
      "WHY: walks the symbol reverse index outward, keeping runtime and type-only impact separate and aggregating per file.",
      {
        mcp: "RETURNS: impact level (high, medium, low), total impact count, runtime versus type-only breakdown, impacted symbols with depth (1 = direct), affected files, and a written summary. An unknown symbol returns an error listing close name matches.",
        lm: "RETURNS: impact level (high, medium, low), total impact count, runtime versus type-only breakdown, impacted symbols with depth (1 = direct) and affected files. Transitive impact only with includeTransitive. An unknown symbol returns an error listing close name matches.",
      },
      OPEN_ENDED_HINT,
    ],
  },
  analyze_file_logic: {
    summary:
      "Returns the call hierarchy among the symbols defined INSIDE one file, ignoring anything it imports.",
    lines: [
      "WHEN: understanding how a file works internally, or spotting recursion before a refactor.",
      "WHY: built from the file's AST (no language server needed), so it works the same in the CLI, MCP and VS Code. Calls are matched by name within the file.",
      "RETURNS: nodes (symbol id, LSP SymbolKind number, type, export status, start/end line range), call edges with call-site line numbers, and cycle detection with the symbols involved.",
      "NOT THIS TOOL: for what this file's symbols reach in OTHER files, use graphitlive_get_symbol_graph.",
      "SUPPORTS: TypeScript, JavaScript, Python, Rust.",
      OPEN_ENDED_HINT,
    ],
  },
  generate_codemap: {
    summary:
      "Returns one file's exports, internals, dependencies, dependents and internal call flow in a single call.",
    lines: [
      "WHEN: getting oriented in an unfamiliar file, or gathering the full context of a file before refactoring it.",
      "WHY: one call in place of analyze_dependencies, get_symbol_graph and find_referencing_files together, plus the calls between the file's own symbols.",
      "RETURNS: path, language, line count, exported and internal symbols, dependencies, dependents, intra-file call flow, cycle detection.",
      "SUPPORTS: TypeScript, JavaScript, Python, Rust, Vue, Svelte.",
    ],
  },
  query_call_graph: {
    summary:
      "Traces calls across files for several hops, in either direction, from a SQLite-backed call graph.",
    lines: [
      `WHEN: "who calls X" (direction=callers, depth=1), "what does X call" (direction=callees), multi-hop traversal ("three levels deep"), or cycle detection across modules.`,
      {
        mcp: "WHY: built from tree-sitter AST analysis, so it holds real call edges (CALLS, INHERITS, IMPLEMENTS) rather than import edges. Type-only references (USES) are added with includeTypeOnly.",
        lm: "WHY: built from tree-sitter AST analysis, so it holds real call edges (CALLS, INHERITS, IMPLEMENTS) and type-only references (USES) rather than import edges. Every relation type is returned unless relationTypes narrows it.",
      },
      {
        mcp: "RETURNS: the matched symbol, its callers and callees with file and line, relation type, and a cyclic flag per edge.",
        lm: "RETURNS: the matched symbol, its callers and callees with file and call-site line, relation type, and a cyclic flag per edge. Defaults: direction=both, depth=2.",
      },
      "NOT THIS TOOL: for every file that imports a file, use graphitlive_find_referencing_files.",
      {
        mcp: `LIMITS: the first call indexes the workspace (3-8s); later queries are fast. Output capped by tokenBudget (default 4000, 0 = no limit); a cut sets truncated=true, omitted counts and nextOffset - pass it as offset to read the rest.`,
        lm: `LIMITS: ${LM_CALL_GRAPH_INDEX}`,
      },
    ],
  },
  scan_dead_code: {
    summary: "Lists the unused exported symbols across a whole workspace or directory.",
    lines: [
      "WHEN: auditing code quality, or cleaning up before a refactor; use find_unused_symbols for a single file.",
      "WHY: combines the reverse index with per-file symbol analysis, so the scan stays linear instead of comparing every file against every other.",
      "RETURNS: files scanned, files holding dead code, total unused symbols, per-file unused symbol lists, scan duration, and truncated with filesBeyondLimit when maxFiles stopped the scan.",
      {
        mcp: "LIMITS: needs background indexing to have finished; an export reached only through a dynamic lookup can still be listed.",
        lm: "LIMITS: scopePath must be an absolute path inside the workspace; results are incomplete while background indexing runs; an export reached only through a dynamic lookup can still be listed.",
      },
    ],
  },
  query_natural_language: {
    summary:
      "Returns the subgraph relevant to a plain-language question, for you to turn into an answer.",
    lines: [
      "WHEN: exploring a codebase from a concept rather than a known file or symbol name.",
      "WHY: extracts keywords, scores seed nodes with full-text search over the call graph index, then traverses outward from them.",
      "RETURNS: the question, the extracted keywords, the subgraph, and timing and truncation metadata.",
      {
        mcp: "LIMITS: returns graph data, not prose - you write the answer from it. The first call indexes the workspace (3-8s).",
        lm: `LIMITS: returns graph data, not prose - you write the answer from it; ${LM_CALL_GRAPH_INDEX}`,
      },
    ],
  },
  generate_wiki: {
    summary: "Writes a navigable markdown wiki of the workspace from the call graph index.",
    lines: [
      "WHEN: producing browsable documentation, or a persistent overview of files and their relationships.",
      "WHY: one article per source file, cross-linked through real caller and callee edges.",
      "RETURNS: number of articles written, index path, articles directory, and the top files by hub score.",
      "LIMITS: writes files to disk. The first call indexes the workspace (3-8s).",
    ],
  },
  get_session_stats: {
    summary:
      "Reports how large this session's TOON responses were against their JSON equivalent, plus real token usage.",
    lines: [
      "WHEN: asked how much the TOON encoding is saving, or for a summary of tool usage.",
      "WHY: encoding sizes are estimated (characters / 4); provider-reported LLM usage is reported separately and never mixed into that estimate.",
      "RETURNS: per-tool and total encoding sizes for this session, llmUsage as its own section, and per-source history.",
      "LIMITS: compares two encodings of the same data - not a saving attributable to the tools themselves.",
    ],
  },
};

function render(name: DescribedToolName, surface: "mcp" | "lm"): string {
  const { summary, lines } = TOOL_DESCRIPTIONS[name];
  const body = lines
    .map((line) => (typeof line === "string" ? line : line[surface]))
    .filter((line): line is string => line !== undefined);
  return `${summary}\n\n${body.join("\n")}`;
}

/** One-sentence summary, as printed by `graph-it tool --list`. */
export function toolSummary(name: DescribedToolName): string {
  return TOOL_DESCRIPTIONS[name].summary;
}

/** Full description registered on the MCP server. */
export function mcpToolDescription(name: DescribedToolName): string {
  return render(name, "mcp");
}

/** `modelDescription` of the VS Code Language Model tool `graph-it-live_<name>`. */
export function lmToolDescription(name: DescribedToolName): string {
  return render(name, "lm").replaceAll("graphitlive_", "graph-it-live_");
}
