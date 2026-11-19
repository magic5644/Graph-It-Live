/**
 * `response_format: "markdown"`: one readable report per tool (#769), the
 * title saying what was asked, then the counts and the tables a reader needs.
 * Shared by the MCP server and the VS Code language model tools.
 *
 * CRITICAL ARCHITECTURE RULE: no vscode import.
 */

type Data = Record<string, unknown>;
type Row = Record<string, unknown>;

/** One line of text: newlines and other control characters would end a list item or a table row. */
export function markdownText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/[\x00-\x1F\x7F]+/g, " ");
}

/** Single-line text that cannot break a table: backslashes go first so `\|` stays an escaped pipe. */
export function markdownCell(text: string): string {
  return markdownText(text).replaceAll("\\", "\\\\").replaceAll("|", String.raw`\|`);
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "object" && item !== null ? (item as Row) : { value: item }));
}

function code(value: unknown): string {
  return `\`${markdownCell(text(value)).replaceAll("`", "'")}\``;
}

/**
 * A table of `items` under `heading`; `columns` picks and orders the columns
 * (missing ones are skipped), else every key. Nothing for an empty list.
 */
function table(heading: string, items: unknown, columns?: string[]): string[] {
  const list = rows(items);
  if (list.length === 0) return [];
  const keys = [...new Set(list.flatMap((row) => Object.keys(row)))];
  const shown = columns ? columns.filter((column) => keys.includes(column)) : keys;
  return [
    `## ${heading} (${list.length})`,
    "",
    `| ${shown.map(markdownCell).join(" | ")} |`,
    `| ${shown.map(() => "---").join(" | ")} |`,
    ...list.map((row) => `| ${shown.map((column) => markdownCell(text(row[column]))).join(" | ")} |`),
    "",
  ];
}

function list(heading: string, items: unknown): string[] {
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) return [];
  return [`## ${heading} (${values.length})`, "", ...values.map((value) => `- ${markdownText(text(value))}`), ""];
}

function bullets(entries: Array<[string, unknown]>): string[] {
  const shown = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return shown.length === 0 ? [] : [...shown.map(([label, value]) => `- ${label}: ${markdownText(text(value))}`), ""];
}

/** The rest of a paged result: what was left out and how to read it. */
function continuation(data: Data): string[] {
  if (data.truncated !== true) return [];
  const next = data.nextOffset === undefined ? "" : ` Pass offset ${text(data.nextOffset)} to read the rest.`;
  return [`_Partial result.${next}_`, ""];
}

function fence(language: string, body: string): string[] {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return [`${marks}${language}`, body, marks, ""];
}

type View = (data: Data) => string[];

const VIEWS: Record<string, View> = {
  set_workspace: (d) => [`# Workspace ${text(d.workspaceName ?? d.workspacePath)}`, "", text(d.message), ""],
  analyze_dependencies: (d) => [
    `# Imports of ${code(d.filePath)}`,
    "",
    ...bullets([["Imports", d.dependencyCount]]),
    ...table("Dependencies", d.dependencies, ["path", "type", "line", "module", "typeOnly"]),
  ],
  crawl_dependency_graph: (d) => [
    `# Dependency graph from ${code(d.entryFile)}`,
    "",
    ...bullets([["Files", d.nodeCount], ["Imports", d.edgeCount], ["Max depth", d.maxDepth]]),
    ...continuation(d),
    ...table("Files", d.nodes, ["path", "dependencyCount", "dependentCount", "hubScore", "communityKey"]),
    ...table("Imports", d.edges, ["source", "target"]),
    ...table(
      "Cycles",
      (Array.isArray(d.circularDependencies) ? d.circularDependencies : []).map((cycle, index) => ({
        files: Array.isArray(cycle) ? cycle.join(" → ") : text(cycle),
        kind: Array.isArray(d.cycleKinds) ? d.cycleKinds[index] : undefined,
      })),
    ),
  ],
  find_referencing_files: (d) => [
    `# Files importing ${code(d.targetPath)}`,
    "",
    ...bullets([["Importers", d.referencingFileCount]]),
    ...table("Importers", d.referencingFiles, ["path", "type", "line", "module"]),
  ],
  verify_dependency_usage: (d) => [
    `# Does ${code(d.sourceFile)} use ${code(d.targetFile)}?`,
    "",
    d.isUsed
      ? "Yes: it uses at least one symbol the target exports."
      : "No: it imports the target but uses none of its symbols.",
    "",
  ],
  resolve_module_path: (d) => [
    `# Resolve ${code(d.moduleSpecifier)} from ${code(d.fromFile)}`,
    "",
    d.resolved ? `Resolved to ${code(d.resolvedRelativePath ?? d.resolvedPath)}.` : `Not resolved: ${markdownText(text(d.failureReason))}`,
    "",
  ],
  get_index_status: (d) => {
    const stats = (d.reverseIndexStats ?? {}) as Data;
    const warmup = (d.warmup ?? {}) as Data;
    return [
      "# Index status",
      "",
      ...bullets([
        ["State", d.state],
        ["Ready", d.isReady],
        ["Files indexed", warmup.filesIndexed ?? stats.indexedFiles],
        ["Import references", stats.totalReferences],
        ["Imports leaving the workspace", d.outOfRootImports],
      ]),
    ];
  },
  invalidate_files: (d) => [
    "# Invalidated files",
    "",
    ...bullets([["Invalidated", d.invalidatedCount]]),
    ...list("Invalidated", d.invalidatedFiles),
    ...list("Not found", d.notFoundFiles),
  ],
  rebuild_index: (d) => {
    const callGraph = (d.callGraph ?? {}) as Data;
    return [
      "# Index rebuilt",
      "",
      ...bullets([
        ["Files re-indexed", d.reindexedCount],
        ["Time (ms)", d.rebuildTimeMs],
        ["Call graph", callGraph.rebuilt ? `${text(callGraph.symbols)} symbols, ${text(callGraph.relations)} relations` : callGraph.error],
      ]),
    ];
  },
  get_symbol_graph: (d) => [
    `# Symbols of ${code(d.filePath)}`,
    "",
    ...table("Symbols", d.symbols, ["name", "kind", "line", "endLine", "isExported"]),
    ...table("Symbol dependencies", d.dependencies, ["sourceSymbolId", "targetSymbolId", "targetRelativePath", "line"]),
  ],
  find_unused_symbols: (d) => [
    `# Unused exports of ${code(d.filePath)}`,
    "",
    ...bullets([["Unused", `${text(d.unusedCount)} of ${text(d.totalExportedSymbols)} exports`], ["Lowest confidence listed", d.minConfidence]]),
    ...table("Unused exports", d.unusedSymbols, ["name", "kind", "line", "confidence", "reason"]),
  ],
  trace_function_execution: (d) => [
    `# Execution trace from ${code((d.rootSymbol as Data | undefined)?.symbolName)}`,
    "",
    ...bullets([["Calls", d.callCount], ["Distinct symbols", d.uniqueSymbolCount], ["Depth limit reached", d.maxDepthReached]]),
    ...table("Calls", d.callChain, ["depth", "callerSymbolId", "calledSymbolId", "resolvedRelativePath", "line"]),
  ],
  analyze_breaking_changes: (d) => [
    `# Signature changes in ${code(d.filePath)}`,
    "",
    ...bullets([["Breaking", d.breakingChangeCount], ["Errors", d.errorCount], ["Warnings", d.warningCount]]),
    ...table("Breaking changes", d.breakingChanges, ["severity", "type", "symbolName", "description", "line"]),
    ...list("Non-breaking changes", d.nonBreakingChanges),
    ...list("Removed symbols", d.removedSymbols),
  ],
  review_pr: (d) => [
    `# Review of ${code(d.baseRef)}..${code(d.headRef)}`,
    "",
    ...bullets([["Risk", d.risk], ["Score", d.score], ["Partial", d.isPartial]]),
    ...list("Changed files", d.changedFiles),
    ...table("Changed symbols", d.symbols),
    ...table("Cycles", d.cycles),
    ...list("Limitations", d.limitations),
  ],
  get_impact_analysis: (d) => [
    `# Impact of changing ${code((d.targetSymbol as Data | undefined)?.symbolName)}`,
    "",
    ...bullets([
      ["Impact level", d.impactLevel],
      ["Impacted", d.totalImpactCount],
      ["Direct", d.directImpactCount],
      ["Transitive", d.transitiveImpactCount],
    ]),
    ...table("Impacted symbols", d.impactedItems, ["symbolId", "filePath", "line", "usageType", "depth"]),
    ...list("Affected files", d.affectedFiles),
  ],
  generate_codemap: (d) => [
    `# Codemap of ${code(d.filePath)}`,
    "",
    ...bullets([["Language", d.language], ["Lines", d.lineCount], ["Call cycle inside the file", d.hasCycle]]),
    ...table("Exports", d.exports, ["name", "kind", "line"]),
    ...table("Internal symbols", d.internals, ["name", "kind", "line"]),
    ...table("Imports", d.dependencies, ["relativePath", "module", "type", "line", "typeOnly"]),
    ...table("Importers", d.dependents, ["path", "type", "line"]),
    ...table("Call flow", d.callFlow),
    ...list("Symbols in a cycle", d.cycleSymbols),
  ],
  query_call_graph: (d) => {
    const symbol = d.symbol as Data | null | undefined;
    if (!symbol) {
      return [
        `# Call graph: ${markdownText(text(d.reason))}`,
        "",
        "Pass symbolId or startLine of one candidate.",
        "",
        ...table("Candidates", d.candidates, ["id", "name", "type", "startLine", "endLine"]),
      ];
    }
    const relations = ["targetName", "sourceName", "relation", "sourceLine", "isCyclic"];
    return [
      `# Call graph of ${code(symbol.name)} (${code(symbol.filePath)}:${text(symbol.startLine)})`,
      "",
      ...bullets([["Callers", d.totalCallers], ["Callees", d.totalCallees], ["Depth", d.depth]]),
      ...continuation(d),
      ...table("Callers", d.callers, ["sourceName", "targetName", "relation", "sourceLine", "isCyclic"]),
      ...table("Callees", d.callees, relations),
    ];
  },
  scan_dead_code: (d) => [
    `# Dead code in ${code(d.scopePath)}`,
    "",
    ...bullets([
      ["Files scanned", d.scannedFiles],
      ["Files with dead code", d.filesWithDeadCode],
      ["Unused exports", d.totalUnusedSymbols],
      ["By confidence", d.byConfidence],
      ["Partial (maxFiles reached)", d.truncated],
    ]),
    ...table(
      "Unused exports",
      rows(d.entries).flatMap((entry) => rows(entry.unusedSymbols).map((symbol) => ({ file: entry.filePath, ...symbol }))),
      ["file", "name", "kind", "line", "confidence", "reason"],
    ),
    ...table("Files", d.files),
    ...table("Excluded", d.excluded),
  ],
  graph_context: (d) => [
    `# Graph context (${markdownText(text(d.mode))})`,
    "",
    ...bullets([["Seeds", Array.isArray(d.seeds) ? d.seeds.length : undefined], ["Fresh index", d.fresh]]),
    ...(d.truncated === true ? [`_Partial result.${d.nextCursor ? " Pass nextCursor as cursor to read the rest." : ""}_`, ""] : []),
    ...(rows(d.nodes).length === 0 ? ["_No node matches the request._", ""] : []),
    ...table("Nodes", d.nodes, ["id", "kind", "name", "path", "startLine", "score"]),
    ...table("Edges", d.edges, ["source", "target", "relation", "confidence"]),
    ...table("Paths", d.paths),
    ...table("Ambiguous", d.ambiguous),
    ...list("Next queries", d.nextQueries),
  ],
  explore_architecture: (d) => [
    `# Architecture: ${markdownText(text(d.view))}`,
    "",
    ...bullets(Object.entries((d.totals ?? {}) as Data)),
    ...table("Units", d.units, ["key", "label", "layer", "fileCount", "roles"]),
    ...table("Unit edges", d.unitEdges, ["from", "to", "fileEdgeCount", "direction"]),
    ...table("Groups", d.groups, ["id", "key", "label", "fileCount", "internalEdgeCount"]),
    ...table("Group edges", d.groupEdges, ["fromLabel", "toLabel", "fileEdgeCount"]),
    ...table("Incoming", d.incoming, ["fromLabel", "toLabel", "fileEdgeCount"]),
    ...table("Outgoing", d.outgoing, ["fromLabel", "toLabel", "fileEdgeCount"]),
    ...list("Files", d.files),
    ...table("File pairs", d.pairs, ["source", "target"]),
    ...table("Matrix rows", d.rows),
    ...table("Matrix cells", d.cells),
    ...table("Cycles", d.cycles),
    ...continuation((d.page ?? {}) as Data),
    ...(d.nextSteps ? [markdownText(text(d.nextSteps)), ""] : []),
  ],
  check_architecture: (d) => [
    "# Architecture rules check",
    "",
    ...bullets(Object.entries((d.totals ?? d.summary ?? {}) as Data)),
    ...table("Violations", d.violations, ["rule", "severity", "from", "to", "source", "target", "message"]),
    ...list("Files no element selects", d.unmatchedFiles),
    ...list("Configuration warnings", d.configWarnings),
    ...continuation((d.page ?? {}) as Data),
  ],
  export_architecture_diagram: (d) => [
    `# Architecture diagram (${markdownText(text(d.format))})`,
    "",
    ...bullets([["Content", d.counts]]),
    ...(d.path === undefined
      ? fence(d.format === "diagram-spec" ? "json" : text(d.format), text(d.markup))
      : [`Written to ${code(d.path)} (${text(d.characters)} characters).`, ""]),
  ],
  query_natural_language: (d) => [
    `# Code answering "${markdownText(text(d.question))}"`,
    "",
    ...bullets([
      ["Keywords", Array.isArray(d.extractedKeywords) ? d.extractedKeywords.join(", ") : undefined],
      ["Symbols", d.nodeCount],
      ["Relations", d.edgeCount],
      ["Partial (token budget)", (d.meta as Data | undefined)?.truncated],
    ]),
    ...table("Symbols", d.nodes),
    ...table("Relations", d.edges),
  ],
  generate_wiki: (d) => [
    "# Wiki generated",
    "",
    ...bullets([["Articles", d.articlesCount], ["Index", d.indexPath], ["Articles folder", d.articlesDir], ["Scope", d.scopeNote]]),
    ...table("Top hubs", d.topHubs, ["name", "score"]),
  ],
  get_session_stats: (d) => {
    const session = (d.currentSession ?? {}) as Data;
    const byTool = Object.entries((session.byTool ?? {}) as Record<string, Data>).map(([tool, stats]) => ({ tool, ...stats }));
    return [
      "# Session token stats",
      "",
      markdownText(text(d.description)),
      "",
      ...bullets(Object.entries((session.totals ?? {}) as Data)),
      ...table("By tool", byTool),
      ...(d.estimationNote ? [`_${markdownText(text(d.estimationNote))}_`, ""] : []),
    ];
  },
};

/** The markdown report of one tool's data, or undefined for a tool without a view. */
export function renderToolMarkdown(toolName: string, data: unknown): string | undefined {
  const view = VIEWS[toolName.replace(/^graphitlive_/, "")];
  if (view === undefined || typeof data !== "object" || data === null) return undefined;
  return view(data as Data).join("\n").trimEnd();
}

/** Tools with a markdown view, for the contract test. */
export const MARKDOWN_VIEW_TOOLS = Object.keys(VIEWS);
