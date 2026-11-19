/**
 * SymbolAnalysisCache — the AST worker's analyses of each file, persisted in the shared
 * `.graph-it/cache/` so a warm run analyzes only the files that changed (#774).
 *
 * NO vscode import — pure Node.js analyzer layer.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SymbolDependency, SymbolInfo } from "../types";
import { getLogger } from "../../shared/logger";
import { normalizePath } from "../../shared/path";

const log = getLogger("SymbolAnalysisCache");

/** Injected at build time into every Node bundle; "0.0.0-dev" in local builds. */
export const ANALYZER_VERSION = process.env.CLI_VERSION ?? "0.0.0-dev";

export const SYMBOLS_FILE = "symbols.cache";

/** Format of symbols.cache. Bump when it changes; an analyzer change is caught by the build id. */
export const SYMBOL_CACHE_SCHEMA = 2;

/** `.graph-it/` holds only generated state, so it ignores itself in git. */
export function ensureGitignore(cacheDir: string): void {
  try {
    fs.writeFileSync(path.join(path.dirname(cacheDir), ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

/**
 * One file's AST analyses, valid while its content hashes to `hash`: JSON text with the file's own path
 * replaced by OWN_PATH, as compact in memory as on disk. Paths are unresolved: no config is read.
 */
interface SymbolCacheEntry {
  hash: string;
  graph?: string;
  /** Internal export dependency graph: [export, callees][] */
  internal?: string;
}

interface SymbolCacheHeader {
  schema: number;
  version: string;
  /** Content hash of the AST worker bundle that wrote the analyses. */
  build: string;
}

// JSON.stringify escapes every control character, so this raw one never occurs in its output: the swap is exact.
const OWN_PATH = "\u0001";
// One file per line: key, hash, graph, internal graph, separated by tabs, which JSON text never holds raw either.
const FIELD = "\t";
const WRITE_CHUNK = 1 << 20;
// A Vue template read from another file (`<template src>`) changes the analysis, not the file's content.
const EXTERNAL_VUE_TEMPLATE = /<template\b[^>]*\ssrc\s*=/i;

const hashOf = (content: string): string => createHash("sha256").update(content).digest("hex");
/** The path as it appears inside JSON strings. */
const jsonText = (key: string): string => JSON.stringify(key).slice(1, -1);
const pack = (key: string, value: unknown): string => JSON.stringify(value).replaceAll(jsonText(key), OWN_PATH);
const unpack = (key: string, text: string): unknown => JSON.parse(text.replaceAll(OWN_PATH, jsonText(key)));

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const isGraph = (value: unknown): value is SymbolGraph =>
  typeof value === "object" && value !== null &&
  Array.isArray((value as SymbolGraph).symbols) && Array.isArray((value as SymbolGraph).dependencies);
const isInternal = (value: unknown): value is [string, string[]][] =>
  Array.isArray(value) && value.every((pair) => Array.isArray(pair) && typeof pair[0] === "string" && isStringArray(pair[1]));

/**
 * Entries stay text until read: each read is a fresh copy, and a large workspace costs little memory.
 * A damaged entry is a miss, never an empty analysis: the file is analyzed again.
 * Concurrent processes: each writes its own temp file then renames it, so the file is always whole; the last
 * writer wins, and what the other one added is analyzed again on a later run.
 */
export class SymbolAnalysisCache {
  private entries: Map<string, SymbolCacheEntry> | undefined;
  private dirty = false;

  /** @param build Identifies the analyzer that writes the analyses: another build starts empty. */
  constructor(private readonly dir: string, private readonly build: string) {}

  getGraph(filePath: string, content: string): SymbolGraph | undefined {
    const graph = this.read(filePath, content, "graph");
    return isGraph(graph) ? graph : this.drop(filePath, "graph", graph);
  }

  setGraph(filePath: string, content: string, graph: SymbolGraph): void {
    const key = normalizePath(filePath);
    this.update(key, content, { graph: pack(key, graph) });
  }

  getInternalGraph(filePath: string, content: string): Map<string, Set<string>> | undefined {
    const internal = this.read(filePath, content, "internal");
    if (!isInternal(internal)) return this.drop(filePath, "internal", internal);
    return new Map(internal.map(([name, callees]) => [name, new Set(callees)]));
  }

  setInternalGraph(filePath: string, content: string, graph: Map<string, Set<string>>): void {
    const key = normalizePath(filePath);
    this.update(key, content, { internal: pack(key, [...graph].map(([name, callees]) => [name, [...callees]])) });
  }

  /** Write what changed since the last save, dropping deleted files, a chunk at a time. Best-effort. */
  save(): void {
    if (!this.dirty || !this.entries) return;
    const filePath = path.join(this.dir, SYMBOLS_FILE);
    const tmpPath = path.join(this.dir, `.${SYMBOLS_FILE}.${process.pid}.tmp`);
    let fd: number | undefined;
    let created = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      ensureGitignore(this.dir);
      fd = fs.openSync(tmpPath, "w");
      created = true;
      const header: SymbolCacheHeader = { schema: SYMBOL_CACHE_SCHEMA, version: ANALYZER_VERSION, build: this.build };
      let chunk = JSON.stringify(header);
      for (const [key, entry] of this.entries) {
        if (!fs.existsSync(key)) {
          this.entries.delete(key);
          continue;
        }
        chunk += `\n${JSON.stringify(key)}${FIELD}${entry.hash}${FIELD}${entry.graph ?? ""}${FIELD}${entry.internal ?? ""}`;
        if (chunk.length >= WRITE_CHUNK) {
          fs.writeSync(fd, chunk);
          chunk = "";
        }
      }
      fs.writeSync(fd, chunk);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, filePath);
      this.dirty = false;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) fs.rmSync(tmpPath, { force: true });
      log.warn("Could not save symbol cache:", error instanceof Error ? error.message : String(error));
    }
  }

  /** The parsed field of an entry for this content; undefined on a miss, null when the field cannot be parsed. */
  private read(filePath: string, content: string, field: "graph" | "internal"): unknown {
    const key = normalizePath(filePath);
    const entry = this.load().get(key);
    const text = entry?.hash === hashOf(content) ? entry[field] : undefined;
    if (text === undefined) return undefined;
    try {
      return unpack(key, text);
    } catch {
      return null;
    }
  }

  /** A damaged analysis (truncated, edited) is forgotten, so the file is analyzed again and saved whole. */
  private drop(filePath: string, field: "graph" | "internal", value: unknown): undefined {
    const entry = value === undefined ? undefined : this.load().get(normalizePath(filePath));
    if (entry) {
      log.warn("Damaged symbol cache entry, analyzing again:", filePath);
      entry[field] = undefined;
      this.dirty = true;
    }
    return undefined;
  }

  private update(key: string, content: string, payload: Omit<SymbolCacheEntry, "hash">): void {
    if (key.toLowerCase().endsWith(".vue") && EXTERNAL_VUE_TEMPLATE.test(content)) return;
    const hash = hashOf(content);
    const previous = this.load().get(key);
    this.load().set(key, { ...(previous?.hash === hash ? previous : {}), ...payload, hash });
    this.dirty = true;
  }

  /** Read once; a missing, corrupt, other-format, other-version or other-build file starts empty. */
  private load(): Map<string, SymbolCacheEntry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    let lines: string[];
    try {
      // A file rewritten with CRLF line ends (an editor, a copy) reads the same.
      lines = fs.readFileSync(path.join(this.dir, SYMBOLS_FILE), "utf-8").split(/\r?\n/);
      const header = JSON.parse(lines[0]) as Partial<SymbolCacheHeader>;
      if (header.schema !== SYMBOL_CACHE_SCHEMA || header.version !== ANALYZER_VERSION || header.build !== this.build) {
        return this.entries;
      }
    } catch {
      // Nothing usable cached: every file is analyzed once, then saved.
      return this.entries;
    }
    for (const line of lines.slice(1)) this.loadLine(line);
    return this.entries;
  }

  /** A line with a damaged key or too few fields (truncated) is skipped: that file is analyzed again. */
  private loadLine(line: string): void {
    const [key, hash, graph, internal] = line.split(FIELD);
    if (internal === undefined) return;
    try {
      const filePath = JSON.parse(key) as unknown;
      if (typeof filePath === "string") this.entries?.set(filePath, { hash, graph: graph || undefined, internal: internal || undefined });
    } catch {
      // Damaged key: skipped.
    }
  }
}
