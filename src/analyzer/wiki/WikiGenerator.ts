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
import type { GraphNodeMetadata } from "../../shared/graph-types.js";
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

/**
 * First line of every generated file. Only marked files are replaced, or removed
 * as stale: a file without it was not written by the generator.
 */
const GENERATED_MARKER = "<!-- graph-it-live:wiki-article -->";

/** Maximum callers/callees listed per article. */
const MAX_LINKS = 20;

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

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const GLOB_TOKENS: Record<string, string> = {
  "**/": "(?:.*/)?",
  "**": ".*",
  "*": "[^/]*",
  "?": "[^/]",
};

function globToRegExp(glob: string): RegExp {
  const re = glob.replaceAll(/\*\*\/|\*\*|[*?]|[.+^${}()|[\]\\]/g, (t) => GLOB_TOKENS[t] ?? `\\${t}`);
  // A match on a directory also excludes everything under it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Gitignore-like matching on a workspace-relative path:
 * - `*` matches within one segment, `**` across segments, `?` one character;
 * - a pattern containing `/` is anchored at the workspace root ("tests/**");
 * - a pattern without `/` matches any segment or trailing part ("*.test.ts", "fixtures").
 */
export function matchesExcludePattern(relPath: string, pattern: string): boolean {
  const p = toRelPattern(pattern);
  if (!p) return false;
  const re = globToRegExp(p);
  if (p.includes("/")) return re.test(relPath);
  const segments = relPath.split("/");
  return segments.some((_, i) => re.test(segments.slice(i).join("/")));
}

function toRelPattern(pattern: string): string {
  let p = pattern.replaceAll("\\", "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const quote = (s: string) => `\`${s}\``;

/** Workspace-relative scope with "/" separators; "" means the whole workspace. */
export function normalizeScope(workspaceRoot: string, scope: string): string {
  const absolute = path.resolve(workspaceRoot, scope.replaceAll("\\", "/"));
  return path.relative(workspaceRoot, absolute).replaceAll("\\", "/");
}

function buildScopePredicate(
  workspaceRoot: string,
  scope?: string,
  exclude?: string[],
): (absPath: string) => boolean {
  const effectiveExclude = exclude ?? [];
  const useDefaults = exclude === undefined;
  const relScope = scope ? normalizeScope(workspaceRoot, scope) : "";

  return (absPath: string): boolean => {
    const rel = path.relative(workspaceRoot, absPath).replaceAll('\\', "/");

    // Scope restriction
    if (relScope && rel !== relScope && !rel.startsWith(`${relScope}/`)) {
      return false;
    }

    // Explicit exclude patterns
    for (const pattern of effectiveExclude) {
      if (matchesExcludePattern(rel, pattern)) return false;
    }

    // Default excludes (applied when no explicit --exclude given)
    return !useDefaults || !isDefaultExcluded(rel);
  };
}

function isDefaultExcluded(rel: string): boolean {
  return (
    DEFAULT_EXCLUDES.some((prefix) => rel.startsWith(prefix)) ||
    DEFAULT_EXCLUDE_SUFFIXES.some((suffix) => rel.endsWith(suffix))
  );
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
  private readonly externalNodeMetadata: Record<string, GraphNodeMetadata> | undefined;
  private readonly overwrite: boolean;
  /** normalized source path → generated article path, for files of the current run. */
  private articlePaths = new Map<string, string>();

  constructor(opts: WikiGeneratorOptions) {
    this.db = opts.db;
    this.outputDir = opts.outputDir;
    this.workspaceRoot = normalizePath(opts.workspaceRoot);
    this.topHubsLimit = opts.topHubsLimit ?? 10;
    this.scope = opts.scope;
    this.exclude = opts.exclude;
    this.externalNodeMetadata = opts.nodeMetadata;
    this.overwrite = opts.overwrite ?? false;
  }

  async generate(): Promise<WikiGenerateResult> {
    const scopePredicate = buildScopePredicate(
      this.workspaceRoot,
      this.scope,
      this.exclude,
    );

    // Build hub score map (DB-derived, 0-100 scale)
    const hubMap = this.buildHubMap();

    // Enumerate files — with scope/exclude applied
    const allFiles = this.queryFiles().map((f) => normalizePath(f));
    const files = allFiles.filter(scopePredicate);
    if (allFiles.length > 0 && files.length === 0) {
      throw new Error(
        `No indexed file matches the wiki filters (${this.describeFilters()}). Check --scope and --exclude.`,
      );
    }
    this.articlePaths = this.assignArticlePaths(files);

    // Build all articles (pure, no I/O)
    const articles: WikiArticle[] = files.map((normalized) => {
      // ADR-F2-01: prefer hubScore from GraphData.nodeMetadata when available.
      // externalNodeMetadata.hubScore is in [0-1]; scale to 0-100 to match WikiArticle range.
      const externalScore = this.externalNodeMetadata?.[normalized]?.hubScore;
      const score = externalScore !== undefined
        ? Math.min(Math.round(externalScore * 100), 100)
        : (hubMap.get(normalized) ?? 0);
      return this.buildArticle(normalized, score);
    });

    // Check every target before the first write, so a refusal leaves no partial wiki.
    const articlesDir = path.join(this.outputDir, "articles");
    const indexPath = path.join(this.outputDir, "index.md");
    await this.assertNoSymlink(articlesDir);
    await Promise.all([indexPath, ...this.articlePaths.values()].map((target) => this.assertWritable(target)));

    // Write output files
    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.mkdir(articlesDir, { recursive: true });

    for (const article of articles) {
      const markdown = this.renderArticle(article);
      await fs.writeFile(article.articlePath, markdown, "utf-8");
    }
    await this.removeStaleArticles(articlesDir);

    // Build architecture diagram from article data
    const archDiagram = buildArchitectureDiagram(
      articles,
      (fp) => displayPath(fp, this.workspaceRoot),
    );

    // Build scope note
    const excludedCount = allFiles.length - files.length;
    const scopeNote = this.buildScopeNote(files.length, excludedCount);

    const indexMarkdown = this.renderIndex(articles, archDiagram, scopeNote);
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

  /**
   * Flattens each workspace-relative path into one article file name. Names that
   * collide (`src/a/b.ts` and `src/a_b.ts`, or names differing only by case on
   * case-insensitive file systems) get a numeric suffix.
   */
  private assignArticlePaths(files: string[]): Map<string, string> {
    const paths = new Map<string, string>();
    const used = new Set<string>();
    for (const file of files) {
      const base = displayPath(file, this.workspaceRoot).replaceAll("/", "_");
      let name = `${base}.md`;
      let n = 1;
      while (used.has(name.toLowerCase())) name = `${base}-${++n}.md`;
      used.add(name.toLowerCase());
      paths.set(file, path.join(this.outputDir, "articles", name));
    }
    return paths;
  }

  /** Rejects a symbolic link, which would redirect writes out of the output directory. */
  private async assertNoSymlink(target: string): Promise<void> {
    const stats = await lstatOrUndefined(target);
    if (stats?.isSymbolicLink()) {
      throw new Error(`Refusing to write through symbolic link ${quote(displayPath(target, this.workspaceRoot))}.`);
    }
  }

  /** Rejects replacing a file the generator did not write, unless overwrite is set. */
  private async assertWritable(target: string): Promise<void> {
    const stats = await lstatOrUndefined(target);
    if (!stats) return;
    const shown = quote(displayPath(target, this.workspaceRoot));
    if (stats.isSymbolicLink()) throw new Error(`Refusing to write through symbolic link ${shown}.`);
    if (!stats.isFile()) throw new Error(`Refusing to write wiki file ${shown}: a directory or special file is in the way.`);
    // A hard link shares its content with a file that may live outside the output directory.
    if (stats.nlink > 1) throw new Error(`Refusing to write wiki file ${shown}: it is a hard link.`);
    if (this.overwrite) return;
    const content = await fs.readFile(target, "utf-8");
    // v1.17.1 wrote index.md without the marker; its exact title line still identifies it.
    const legacyIndex = path.basename(target) === "index.md"
      && content.startsWith(`# Wiki — ${path.basename(this.workspaceRoot)}\n`);
    if (!content.startsWith(GENERATED_MARKER) && !legacyIndex) {
      throw new Error(
        `Refusing to overwrite ${shown}: it was not generated by the wiki. Move it or choose another output directory (the CLI replaces it with --force).`,
      );
    }
  }

  /** Deletes articles left by a previous run; files without the marker are kept. */
  private async removeStaleArticles(articlesDir: string): Promise<void> {
    const current = new Set([...this.articlePaths.values()].map((p) => path.basename(p)));
    const entries = await fs.readdir(articlesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || current.has(entry.name)) continue;
      const stalePath = path.join(articlesDir, entry.name);
      const content = await fs.readFile(stalePath, "utf-8");
      if (content.startsWith(GENERATED_MARKER)) await fs.rm(stalePath, { force: true });
    }
  }

  private describeFilters(): string {
    const parts: string[] = [];
    if (this.scope) parts.push(`scope ${quote(normalizeScope(this.workspaceRoot, this.scope) || ".")}`);
    if (this.exclude?.length) parts.push(`exclude ${this.exclude.map(quote).join(", ")}`);
    if (!this.exclude) parts.push("default excludes");
    return parts.join(", ");
  }

  private buildScopeNote(includedCount: number, excludedCount: number): string | undefined {
    const parts: string[] = [];
    if (this.scope) {
      parts.push(`scope: ${quote(normalizeScope(this.workspaceRoot, this.scope) || ".")}`);
    }
    if (this.exclude?.length) parts.push(`excluding: ${this.exclude.map(quote).join(", ")}`);
    if (!this.exclude) parts.push("auto-excludes: tests/, dist/, *.test.ts applied");
    if (excludedCount > 0) parts.push(`${excludedCount} file${excludedCount > 1 ? "s" : ""} excluded`);

    if (parts.length === 0) return undefined;
    return `${includedCount} files included — ${parts.join(" · ")}`;
  }

  buildArticle(filePath: string, hubScore: number): WikiArticle {
    const ext = path.extname(filePath);
    const title = path.basename(filePath, ext);
    const articlePath =
      this.articlePaths.get(filePath) ??
      path.join(
        this.outputDir,
        "articles",
        displayPath(filePath, this.workspaceRoot).replaceAll('/', "_") + ".md",
      );

    const symbols = this.querySymbols(filePath);
    const allCallers = this.queryCallers(filePath);
    const allCallees = this.queryCallees(filePath);
    const callers = allCallers.slice(0, MAX_LINKS);
    const callees = allCallees.slice(0, MAX_LINKS);
    const display = (fp: string) => displayPath(fp, this.workspaceRoot);

    const base: WikiArticle = {
      title,
      filePath,
      articlePath,
      hubScore,
      symbols,
      callers,
      callees,
      callerCount: allCallers.length,
      calleeCount: allCallees.length,
      diagrams: [],
    };

    // Build diagrams
    const diagrams: MermaidDiagram[] = [];

    const depDiagram = buildDependencyDiagram(base, display);
    if (depDiagram) diagrams.push(depDiagram);

    const callerDiagram = buildCallerDiagram(base, display);
    if (callerDiagram) diagrams.push(callerDiagram);

    // Control flow diagrams (only for TS/JS files)
    const ext2 = path.extname(filePath).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext2)) {
      const cfDiagrams = analyzeControlFlow(filePath);
      diagrams.push(...cfDiagrams);
    }

    return { ...base, diagrams };
  }

  renderArticle(article: WikiArticle): string {
    const lines: string[] = [];
    const relSrc = displayPath(article.filePath, this.workspaceRoot);
    // Escape characters that break Markdown table/link syntax or enable HTML/autolink
    // injection when interpolated from source-derived names (file/symbol names are attacker-controlled).
    const safe = (s: string) =>
      s
        .replaceAll("\\", String.raw`\\`)
        .replaceAll("|", String.raw`\|`)
        .replaceAll("[", String.raw`\[`)
        .replaceAll("]", String.raw`\]`)
        .replaceAll("(", String.raw`\(`)
        .replaceAll(")", String.raw`\)`)
        .replaceAll("`", String.raw`\``)
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll(/\r?\n/g, " ");

    const headerLines = [GENERATED_MARKER, `# ${safe(article.title)}`, `> ${safe(relSrc)} | Hub Score: ${article.hubScore}/100`, ""];
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

    lines.push(
      ...this.renderLinkTable("Called by", "callers", article, article.callers, article.callerCount, safe),
      ...this.renderLinkTable("External calls", "callees", article, article.callees, article.calleeCount, safe),
    );

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

  /**
   * Links point only to articles generated in this run; other files are shown
   * as plain text. A note states how many entries were left out.
   */
  private renderLinkTable(
    heading: string,
    noun: string,
    article: WikiArticle,
    links: WikiLink[],
    total: number,
    safe: (s: string) => string,
  ): string[] {
    if (links.length === 0) return [];
    const lines = [`## ${heading}`];
    if (total > links.length) lines.push(`> ${links.length} of ${total} ${noun} shown.`, "");
    lines.push("| Symbol | File | Line |", "|--------|------|------|");
    for (const c of links) {
      const fileDisplay = safe(displayPath(c.filePath, this.workspaceRoot));
      const target = this.articlePaths.get(c.filePath);
      const file = target ? `[${fileDisplay}](${relLink(article.articlePath, target)})` : fileDisplay;
      lines.push(`| ${safe(c.name)} | ${file} | ${c.callSiteLine} |`);
    }
    lines.push("");
    return lines;
  }

  renderIndex(
    articles: WikiArticle[],
    archDiagram: MermaidDiagram | null,
    scopeNote: string | undefined,
  ): string {
    const sorted = [...articles].sort((a, b) => b.hubScore - a.hubScore);
    const godNode = sorted[0];
    const lines: string[] = [];

    const headerLines = [GENERATED_MARKER, `# Wiki — ${path.basename(this.workspaceRoot)}`, ""];
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
        `[${godNode.title}](${godLink}) — Hub Score: ${godNode.hubScore}/100 — ${godNode.symbols.length} symbols — ${godNode.callerCount} callers`,
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
          return `| [${a.title}](${link}) | ${a.hubScore} | ${a.symbols.length} | ${a.callerCount} | ${a.diagrams.length} |`;
        }),
        "",
      ];
      lines.push(...folderLines);
    }

    return lines.join("\n");
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
