export type SymbolNodeType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable";

export interface WikiSymbol {
  name: string;
  type: SymbolNodeType;
  declarationLine: number; // = start_line from nodes table
}

export interface WikiLink {
  name: string;
  filePath: string; // absolute normalized — internal use only, never emitted in markdown
  callSiteLine: number; // = source_line from edges table
}

export interface MermaidDiagram {
  title: string;
  type: "dependency" | "caller" | "control-flow" | "architecture";
  mermaid: string;
  truncated: boolean;
  /** Shown as a blockquote in the generated markdown when truncated. */
  truncationNote?: string;
}

export interface WikiArticle {
  title: string; // = path.basename(filePath, ext)
  filePath: string; // absolute normalized — internal use only
  articlePath: string; // absolute path of generated .md file — internal use only
  hubScore: number; // 0–100 normalized
  symbols: WikiSymbol[];
  callers: WikiLink[]; // top 20
  callees: WikiLink[]; // top 20
  diagrams: MermaidDiagram[];
}

export interface WikiScopeOptions {
  /** Relative path within workspace to restrict wiki to (e.g. "src/"). */
  scope?: string;
  /** Relative glob-like patterns to exclude (e.g. ["tests/**", "*.test.ts"]). */
  exclude?: string[];
}

export interface WikiGeneratorOptions extends WikiScopeOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any; // sql.js Database — typed as any to avoid sql.js import in shared/
  outputDir: string; // absolute
  workspaceRoot: string; // absolute
  topHubsLimit?: number; // default 10
  /**
   * Optional per-node metadata from GraphData.nodeMetadata.
   * When present, WikiGenerator uses nodeMetadata[normalizePath(filePath)].hubScore
   * (scaled ×100 to match WikiArticle 0-100 range) instead of computing from DB edges.
   * Key = normalizePath(filePath).
   */
  nodeMetadata?: Record<string, import('./graph-types.js').GraphNodeMetadata>;
}

export interface WikiGenerateResult {
  articlesCount: number;
  indexPath: string; // absolute — relativized by CLI/MCP before returning to caller
  articlesDir: string; // absolute
  topHubs: Array<{ name: string; score: number }>;
  /** Human-readable scope / exclusion summary — included in generated index.md. */
  scopeNote?: string;
}
