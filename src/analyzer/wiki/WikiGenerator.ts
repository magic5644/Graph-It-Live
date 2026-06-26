import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath } from "../../shared/path.js";
import type {
  MermaidDiagram,
  WikiArticle,
  WikiGenerateResult,
  WikiGeneratorOptions,
  WikiLink,
  WikiSymbol,
} from "../../shared/wiki-types.js";
import { analyzeControlFlow } from "./ControlFlowAnalyzer.js";
import {
  buildArchitectureDiagram,
  buildCallerDiagram,
  buildDependencyDiagram,
} from "./DiagramBuilder.js";

// Constraint #0: NEVER emit absolute paths in generated markdown.
// - Internal storage: normalizePath(filePath) — for Sets/Maps
// - Markdown links: path.relative(from, to).replace(/\\/g, '/')
// - Markdown display: path.relative(workspaceRoot, filePath).replace(/\\/g, '/')

function relLink(fromArticlePath: string, toArticlePath: string): string {
  return path
    .relative(path.dirname(fromArticlePath), toArticlePath)
    .replaceAll('\\', "/");
}

function displayPath(filePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, filePath).replaceAll('\\', "/");
}

// ---------------------------------------------------------------------------
// Scope filtering helpers
// ---------------------------------------------------------------------------

/**
 * Default exclusion patterns applied when no explicit --exclude is passed.
 * Each entry is checked against the relative path from workspaceRoot.
 */
const DEFAULT_EXCLUDES = [
  "tests/",
  "test/",
  "__tests__/",
  "dist/",
  "out/",
  "build/",
  "node_modules/",
  ".git/",
  ".claude/",
  ".github/",
  "graphify-out/",
];

const DEFAULT_EXCLUDE_SUFFIXES = [
  ".test.ts",
  ".spec.ts",
  ".test.js",
  ".spec.js",
  ".test.tsx",
  ".spec.tsx",
  ".d.ts",
  ".min.js",
];

function matchesSimplePattern(relPath: string, pattern: string): boolean {
  // "tests/**" or "tests/" → starts with
  const p = pattern.replace(/\/\*\*$/, "/").replaceAll('**/', "").replaceAll('*', "");
  if (pattern.endsWith("/**") || pattern.endsWith("/")) {
    return relPath.startsWith(p);
  }
  // "**/*.test.ts" → suffix check
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return relPath.endsWith(suffix) || relPath.includes(`/${suffix}`);
  }
  // Exact match or contains
  return relPath === p || relPath.includes(p);
}

function buildScopePredicate(
  workspaceRoot: string,
  scope?: string,
  exclude?: string[],
): (absPath: string) => boolean {
  const effectiveExclude = exclude ?? [];
  const useDefaults = exclude === undefined;

  return (absPath: string): boolean => {
    const rel = path.relative(workspaceRoot, absPath).replaceAll('\\', "/");

    // Scope restriction
    if (scope) {
      const normalizedScope = scope.replaceAll('\\', "/").replace(/\/$/, "") + "/";
      if (!rel.startsWith(normalizedScope) && rel !== scope.replace(/\/$/, "")) {
        return false;
      }
    }

    // Explicit exclude patterns
    for (const pattern of effectiveExclude) {
      if (matchesSimplePattern(rel, pattern)) return false;
    }

    // Default excludes (applied when no explicit --exclude given)
    if (useDefaults) {
      for (const prefix of DEFAULT_EXCLUDES) {
        if (rel.startsWith(prefix)) return false;
      }
      for (const suffix of DEFAULT_EXCLUDE_SUFFIXES) {
        if (rel.endsWith(suffix)) return false;
      }
    }

    return true;
  };
}

// ---------------------------------------------------------------------------
// WikiGenerator
// ---------------------------------------------------------------------------

export class WikiGenerator {
  private readonly db: {
    exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
    prepare: (sql: string) => {
      bind: (params: unknown[]) => void;
      step: () => boolean;
      getAsObject: () => Record<string, unknown>;
      free: () => void;
    };
  };
  private readonly outputDir: string;
  private readonly workspaceRoot: string;
  private readonly topHubsLimit: number;
  private readonly scope: string | undefined;
  private readonly exclude: string[] | undefined;

  constructor(opts: WikiGeneratorOptions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db = opts.db;
    this.outputDir = opts.outputDir;
    this.workspaceRoot = opts.workspaceRoot;
    this.topHubsLimit = opts.topHubsLimit ?? 10;
    this.scope = opts.scope;
    this.exclude = opts.exclude;
  }

  async generate(): Promise<WikiGenerateResult> {
    const scopePredicate = buildScopePredicate(
      this.workspaceRoot,
      this.scope,
      this.exclude,
    );

    // Build hub score map
    const hubMap = this.buildHubMap();

    // Enumerate files — with scope/exclude applied
    const allFiles = this.queryFiles();
    const files = allFiles.filter(scopePredicate);

    // Build all articles (pure, no I/O)
    const articles: WikiArticle[] = files.map((filePath) => {
      const normalized = normalizePath(filePath);
      const score = hubMap.get(normalized) ?? 0;
      return this.buildArticle(normalized, score);
    });

    // Write output files
    await fs.mkdir(this.outputDir, { recursive: true });
    const articlesDir = path.join(this.outputDir, "articles");
    await fs.mkdir(articlesDir, { recursive: true });

    for (const article of articles) {
      const markdown = this.renderArticle(article);
      await fs.writeFile(article.articlePath, markdown, "utf-8");
    }

    // Build architecture diagram from article data
    const archDiagram = buildArchitectureDiagram(
      articles,
      (fp) => displayPath(fp, this.workspaceRoot),
    );

    // Build scope note
    const excludedCount = allFiles.length - files.length;
    const scopeNote = this.buildScopeNote(files.length, excludedCount);

    const indexMarkdown = this.renderIndex(articles, archDiagram, scopeNote);
    const indexPath = path.join(this.outputDir, "index.md");
    await fs.writeFile(indexPath, indexMarkdown, "utf-8");

    // Build topHubs
    const sorted = [...articles].sort((a, b) => b.hubScore - a.hubScore);
    const topHubs = sorted.slice(0, this.topHubsLimit).map((a) => ({
      name: a.title,
      score: a.hubScore,
    }));

    return {
      articlesCount: articles.length,
      indexPath,
      articlesDir,
      topHubs,
      scopeNote,
    };
  }

  private buildScopeNote(includedCount: number, excludedCount: number): string | undefined {
    const parts: string[] = [];
    if (this.scope) {
      const displayScope = path.isAbsolute(this.scope)
        ? path.relative(this.workspaceRoot, this.scope)
        : this.scope;
      parts.push(`scope: \`${displayScope}\``);
    }
    if (this.exclude?.length) parts.push(`excluding: ${this.exclude.map((e) => `\`${e}\``).join(", ")}`);
    if (!this.exclude) parts.push("auto-excludes: tests/, dist/, *.test.ts applied");
    if (excludedCount > 0) parts.push(`${excludedCount} file${excludedCount > 1 ? "s" : ""} excluded`);

    if (parts.length === 0) return undefined;
    return `${includedCount} files included — ${parts.join(" · ")}`;
  }

  buildArticle(filePath: string, hubScore: number): WikiArticle {
    const ext = path.extname(filePath);
    const title = path.basename(filePath, ext);
    const articlePath = path.join(
      this.outputDir,
      "articles",
      displayPath(filePath, this.workspaceRoot).replaceAll('/', "_") + ".md",
    );

    const symbols = this.querySymbols(filePath);
    const callers = this.queryCallers(filePath);
    const callees = this.queryCallees(filePath);
    const display = (fp: string) => displayPath(fp, this.workspaceRoot);

    // Build diagrams
    const diagrams: MermaidDiagram[] = [];

    const depDiagram = buildDependencyDiagram({ title, filePath, articlePath, hubScore, symbols, callers, callees, diagrams: [] }, display);
    if (depDiagram) diagrams.push(depDiagram);

    const callerDiagram = buildCallerDiagram({ title, filePath, articlePath, hubScore, symbols, callers, callees, diagrams: [] }, display);
    if (callerDiagram) diagrams.push(callerDiagram);

    // Control flow diagrams (only for TS/JS files)
    const ext2 = path.extname(filePath).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext2)) {
      const cfDiagrams = analyzeControlFlow(filePath);
      diagrams.push(...cfDiagrams);
    }

    return { title, filePath, articlePath, hubScore, symbols, callers, callees, diagrams };
  }

  renderArticle(article: WikiArticle): string {
    const lines: string[] = [];
    const relSrc = displayPath(article.filePath, this.workspaceRoot);
    const escapedBackslash = String.raw`\\`;
    const escapedPipe = String.raw`\|`;
    const safe = (s: string) => s.replaceAll("\\", escapedBackslash).replaceAll("|", escapedPipe);

    const headerLines = [`# ${article.title}`, `> ${relSrc} | Hub Score: ${article.hubScore}/100`, ""];
    lines.push(...headerLines);

    if (article.symbols.length > 0) {
      const symbolLines = [
        "## Symbols",
        "| Name | Type | Line |",
        "|------|------|------|",
        ...article.symbols.map((s) => `| ${safe(s.name)} | ${s.type} | ${s.declarationLine} |`),
        "",
      ];
      lines.push(...symbolLines);
    }

    if (article.callers.length > 0) {
      const callerLines = [
        "## Called by",
        "| Symbol | File | Line |",
        "|--------|------|------|",
        ...article.callers.map((c) => {
          const link = relLink(article.articlePath, this.articlePathFor(c.filePath));
          const fileDisplay = displayPath(c.filePath, this.workspaceRoot);
          return `| ${safe(c.name)} | [${safe(fileDisplay)}](${link}) | ${c.callSiteLine} |`;
        }),
        "",
      ];
      lines.push(...callerLines);
    }

    if (article.callees.length > 0) {
      const calleeLines = [
        "## External calls",
        "| Symbol | File | Line |",
        "|--------|------|------|",
        ...article.callees.map((c) => {
          const link = relLink(article.articlePath, this.articlePathFor(c.filePath));
          const fileDisplay = displayPath(c.filePath, this.workspaceRoot);
          return `| ${safe(c.name)} | [${safe(fileDisplay)}](${link}) | ${c.callSiteLine} |`;
        }),
        "",
      ];
      lines.push(...calleeLines);
    }

    const diagramLines = article.diagrams.flatMap((diagram) => {
      const block = [`## ${diagram.title}`];
      if (diagram.truncationNote) {
        block.push(`> ⚠️ ${diagram.truncationNote}`, "");
      }
      block.push("```mermaid", diagram.mermaid, "```", "");
      return block;
    });
    lines.push(...diagramLines);

    return lines.join("\n");
  }

  renderIndex(
    articles: WikiArticle[],
    archDiagram: MermaidDiagram | null,
    scopeNote: string | undefined,
  ): string {
    const sorted = [...articles].sort((a, b) => b.hubScore - a.hubScore);
    const godNode = sorted[0];
    const lines: string[] = [];

    const headerLines = [`# Wiki — ${path.basename(this.workspaceRoot)}`, ""];
    lines.push(...headerLines);

    // Scope note
    if (scopeNote) {
      lines.push(`> ℹ️ ${scopeNote}`, "");
    }

    // Architecture diagram
    if (archDiagram) {
      const archLines = ["## Architecture overview"];
      if (archDiagram.truncationNote) {
        archLines.push(`> ⚠️ ${archDiagram.truncationNote}`, "");
      }
      archLines.push("```mermaid", archDiagram.mermaid, "```", "");
      lines.push(...archLines);
    }

    if (godNode) {
      const godLink = relLink(
        path.join(this.outputDir, "index.md"),
        godNode.articlePath,
      );
      lines.push(
        "## God Node",
        `[${godNode.title}](${godLink}) — Hub Score: ${godNode.hubScore}/100 — ${godNode.symbols.length} symbols — ${godNode.callers.length} callers`,
        ""
      );
    }

    // Group by folder
    const folders = new Map<string, WikiArticle[]>();
    for (const article of sorted) {
      const folder =
        path
          .relative(this.workspaceRoot, path.dirname(article.filePath))
          .replaceAll('\\', "/") || ".";
      const key = normalizePath(folder);
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key)!.push(article);
    }

    for (const [folder, folderArticles] of folders) {
      const folderLines = [
        `## ${folder}/`,
        "| File | Hub Score | Symbols | Callers | Diagrams |",
        "|------|-----------|---------|---------|----------|",
        ...folderArticles.map((a) => {
          const link = relLink(
            path.join(this.outputDir, "index.md"),
            a.articlePath,
          );
          return `| [${a.title}](${link}) | ${a.hubScore} | ${a.symbols.length} | ${a.callers.length} | ${a.diagrams.length} |`;
        }),
        "",
      ];
      lines.push(...folderLines);
    }

    return lines.join("\n");
  }

  private articlePathFor(filePath: string): string {
    const normalized = normalizePath(filePath);
    return path.join(
      this.outputDir,
      "articles",
      displayPath(normalized, this.workspaceRoot).replaceAll('/', "_") + ".md",
    );
  }

  private buildHubMap(): Map<string, number> {
    const map = new Map<string, number>();
    let maxHub = 0;

    try {
      const result = this.db.exec(`
        SELECT n.path, COUNT(DISTINCT e.source_id) AS hub
        FROM edges e JOIN nodes n ON e.target_id = n.id
        GROUP BY n.path
        ORDER BY hub DESC
      `);

      if (result.length > 0) {
        const rows = result[0];
        const pathIdx = rows.columns.indexOf("path");
        const hubIdx = rows.columns.indexOf("hub");
        for (const row of rows.values) {
          const hub = Number(row[hubIdx]) || 0;
          if (hub > maxHub) maxHub = hub;
          map.set(normalizePath(String(row[pathIdx])), hub);
        }
      }
    } catch {
      // No edges yet — all hub scores = 0
    }

    if (maxHub > 0) {
      for (const [k, v] of map) {
        map.set(k, Math.round((v / maxHub) * 100));
      }
    }

    return map;
  }

  private queryFiles(): string[] {
    const files: string[] = [];
    try {
      const result = this.db.exec("SELECT path FROM file_index ORDER BY path ASC");
      if (result.length > 0) {
        const pathIdx = result[0].columns.indexOf("path");
        for (const row of result[0].values) {
          files.push(String(row[pathIdx]));
        }
      }
    } catch {
      // Fall back to distinct paths in nodes
      try {
        const result = this.db.exec(
          "SELECT DISTINCT path FROM nodes ORDER BY path ASC",
        );
        if (result.length > 0) {
          const pathIdx = result[0].columns.indexOf("path");
          for (const row of result[0].values) {
            files.push(String(row[pathIdx]));
          }
        }
      } catch {
        // empty
      }
    }
    return files;
  }

  private querySymbols(filePath: string): WikiSymbol[] {
    const symbols: WikiSymbol[] = [];
    try {
      const stmt = this.db.prepare(
        "SELECT name, type, start_line FROM nodes WHERE path = ? ORDER BY start_line ASC",
      );
      stmt.bind([filePath]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          name: string;
          type: string;
          start_line: number;
        };
        symbols.push({
          name: row.name,
          type: row.type as WikiSymbol["type"],
          declarationLine: row.start_line,
        });
      }
      stmt.free();
    } catch {
      // empty
    }
    return symbols;
  }

  private queryCallers(filePath: string): WikiLink[] {
    const callers: WikiLink[] = [];
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT n_src.path AS caller_path, n_src.name AS caller_name, e.source_line
        FROM edges e
        JOIN nodes n_tgt ON e.target_id = n_tgt.id
        JOIN nodes n_src ON e.source_id = n_src.id
        WHERE n_tgt.path = ?
        ORDER BY e.source_line ASC
        LIMIT 20
      `);
      stmt.bind([filePath]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          caller_path: string;
          caller_name: string;
          source_line: number;
        };
        callers.push({
          name: row.caller_name,
          filePath: normalizePath(row.caller_path),
          callSiteLine: row.source_line,
        });
      }
      stmt.free();
    } catch {
      // empty
    }
    return callers;
  }

  private queryCallees(filePath: string): WikiLink[] {
    const callees: WikiLink[] = [];
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT n_tgt.path AS callee_path, n_tgt.name AS callee_name, e.source_line
        FROM edges e
        JOIN nodes n_src ON e.source_id = n_src.id
        JOIN nodes n_tgt ON e.target_id = n_tgt.id
        WHERE n_src.path = ?
        ORDER BY e.source_line ASC
        LIMIT 20
      `);
      stmt.bind([filePath]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as {
          callee_path: string;
          callee_name: string;
          source_line: number;
        };
        callees.push({
          name: row.callee_name,
          filePath: normalizePath(row.callee_path),
          callSiteLine: row.source_line,
        });
      }
      stmt.free();
    } catch {
      // empty
    }
    return callees;
  }
}
