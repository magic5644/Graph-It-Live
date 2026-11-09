/**
 * statsPersistence — writes/reads session stats snapshots under ~/.graph-it/stats/.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Design (spec v2, GATE-5):
 * - One file per session: `<source>-<sessionId>.json` (source encoded in the
 *   name so rotation per source never reads file contents).
 * - Atomic write: write to a temp file then renameSync (same directory).
 * - Synchronous on purpose: flush happens in process signal handlers.
 * - Idempotent: re-flushing the same session overwrites the same file.
 * - Opt-out: GRAPH_IT_NO_STATS=1 disables persistence (memory collection
 *   continues elsewhere).
 * - Rotation: max 50 files per source, oldest (mtime) evicted first.
 * - Cumulative totals: `cumulative.totals` (JSON, not `.json` so rotation and
 *   older releases ignore it) survives rotation; each session counts once.
 * - Periodic flush: long-running processes rewrite their session file at most
 *   PERIODIC_FLUSH_DELAY_MS after a new record (startPeriodicFlush).
 * - Snapshots contain no workspace paths nor code content by construction.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  SessionStatsCollector,
  SessionStatsSnapshot,
  SessionStatsSource,
  StatsAggregate,
} from '@/shared/sessionStats';

const MAX_FILES_PER_SOURCE = 50;
const CUMULATIVE_FILE = 'cumulative.totals';
// shortcut: an evicted session rewritten after 500 later evictions counts twice; raise if that ever happens.
const MAX_EVICTED_TRACKED = 500;
/** Delay between the first unsaved record and the periodic session rewrite. */
export const PERIODIC_FLUSH_DELAY_MS = 30_000;

/** Default stats directory: ~/.graph-it/stats */
export function getDefaultStatsDir(): string {
  return path.join(os.homedir(), '.graph-it', 'stats');
}

function isDisabled(): boolean {
  return process.env.GRAPH_IT_NO_STATS === '1';
}

function ensureDir(dir: string): void {
  // 0o700 attempted; mode is a no-op on Windows — accepted.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function sessionFileName(snapshot: Pick<SessionStatsSnapshot, 'source' | 'sessionId'>): string {
  return `${snapshot.source}-${snapshot.sessionId}.json`;
}

function snapshotHasEntries(snapshot: SessionStatsSnapshot): boolean {
  return snapshot.totals.calls > 0 || snapshot.llmUsage.calls > 0;
}

/**
 * Persist a session snapshot to `<baseDir>/<source>-<sessionId>.json`.
 *
 * Skips silently when GRAPH_IT_NO_STATS=1 or when the snapshot has no entries.
 * Upsert semantics: flushing twice for the same session rewrites the same file.
 * Triggers rotation after writing.
 *
 * @param snapshot snapshot to persist
 * @param baseDir override of the stats directory (tests); defaults to ~/.graph-it/stats
 */
export function flushSession(snapshot: SessionStatsSnapshot, baseDir?: string): void {
  if (isDisabled()) {
    return;
  }
  if (!snapshotHasEntries(snapshot)) {
    return;
  }

  const dir = baseDir ?? getDefaultStatsDir();
  ensureDir(dir);

  const fileName = sessionFileName(snapshot);
  writeAtomic(dir, fileName, JSON.stringify(snapshot, null, 2));

  rotate(dir);
  updateCumulative(dir, snapshot.startedAt);
}

function writeAtomic(dir: string, fileName: string, content: string): void {
  // Temp file in the same directory, then rename.
  const tmpPath = path.join(dir, `.${fileName}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, path.join(dir, fileName));
}

/**
 * Read all persisted session snapshots from the stats directory.
 *
 * - Missing directory → [] (covers "file absent" criterion).
 * - Corrupted / unreadable file → skipped with a stderr warning, never throws.
 * - Session started before v1.14.1 (counted as chars/4) → skipped; later ones
 *   are labelled cl100k_base, whatever label they were written with.
 *
 * @param baseDir override of the stats directory (tests); defaults to ~/.graph-it/stats
 * @param quiet skip the warnings (background flushes)
 */
/** Release date of v1.14.1, the first release whose stats count tokens with cl100k_base. */
export const CL100K_COUNTING_SINCE = Date.parse('2026-08-28T14:13:27Z');

export function readAllSessions(baseDir?: string, quiet = false): SessionStatsSnapshot[] {
  const dir = baseDir ?? getDefaultStatsDir();
  const warn = (message: string): void => {
    if (!quiet) console.warn(message);
  };

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dir);
  } catch {
    // Directory absent (or unreadable) → no history.
    return [];
  }

  const snapshots: SessionStatsSnapshot[] = [];
  for (const name of fileNames) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as SessionStatsSnapshot;
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1 && typeof parsed.startedAt === 'number') {
        // Counted as chars/4: another unit, so it cannot be summed with the rest.
        if (parsed.startedAt < CL100K_COUNTING_SINCE) continue;
        // Releases up to v1.24.0 wrote 'chars/4 heuristic' while counting with cl100k_base.
        snapshots.push({ ...parsed, estimationMethod: 'cl100k_base' });
      } else {
        warn(`graph-it stats: skipping invalid stats file: ${name}`);
      }
    } catch {
      warn(`graph-it stats: skipping corrupted stats file: ${name}`);
    }
  }
  return snapshots;
}

/**
 * Enforce max 50 files per source (prefix of the file name before first '-').
 * Oldest files (mtime) are deleted first. Sources never evict each other.
 *
 * @param baseDir stats directory to rotate; defaults to ~/.graph-it/stats
 */
export function rotate(baseDir?: string): void {
  const dir = baseDir ?? getDefaultStatsDir();

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dir);
  } catch {
    return;
  }

  const bySource = new Map<string, Array<{ filePath: string; mtimeMs: number }>>();

  for (const name of fileNames) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const dashIndex = name.indexOf('-');
    if (dashIndex <= 0) {
      continue;
    }
    const source = name.slice(0, dashIndex);
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      let bucket = bySource.get(source);
      if (!bucket) {
        bucket = [];
        bySource.set(source, bucket);
      }
      bucket.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // File vanished between readdir and stat — ignore.
    }
  }

  for (const bucket of bySource.values()) {
    if (bucket.length <= MAX_FILES_PER_SOURCE) {
      continue;
    }
    bucket.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = bucket.length - MAX_FILES_PER_SOURCE;
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(bucket[i].filePath);
      } catch {
        // Deletion race — ignore.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summaries (history window and cumulative totals)
// ---------------------------------------------------------------------------

/** Session counters for one source, or for all sources together. */
export interface SourceAggregate extends StatsAggregate {
  sessions: number;
  /** Real provider-reported LLM usage — never summed into the estimated fields. */
  llmCalls: number;
  llmTokensUsed: number;
}

export type SourceAggregates = Partial<Record<SessionStatsSource, SourceAggregate>>;

/** Persisted session window (last 50 per source) aggregated by source, plus all sources. */
export interface HistorySummary {
  persistedSessions: number;
  bySource: SourceAggregates;
  total: SourceAggregate;
}

/** Totals since the first counted session; unaffected by rotation. */
export interface CumulativeSummary {
  /** ISO date of the first counted session. */
  since: string;
  bySource: SourceAggregates;
  total: SourceAggregate;
}

type SessionContribution = Pick<SessionStatsSnapshot, 'source' | 'startedAt' | 'totals' | 'llmUsage'>;

interface CumulativeFile {
  schemaVersion: 1;
  since: number;
  /** Sessions evicted long ago: kept as sums only. */
  retired: SourceAggregates;
  /** Recently evicted sessions, keyed by file name: a live process may still rewrite their file. */
  evicted?: Record<string, SessionContribution>;
  /** Sessions still on disk, keyed by file name; a rewrite replaces its entry. */
  sessions: Record<string, SessionContribution>;
}

function emptySourceAggregate(): SourceAggregate {
  return { sessions: 0, calls: 0, jsonTokens: 0, toonTokens: 0, savings: 0, truncations: 0, llmCalls: 0, llmTokensUsed: 0 };
}

function addSession(bySource: SourceAggregates, session: SessionContribution): void {
  const agg = (bySource[session.source] ??= emptySourceAggregate());
  agg.sessions += 1;
  agg.calls += session.totals.calls;
  agg.jsonTokens += session.totals.jsonTokens;
  agg.toonTokens += session.totals.toonTokens;
  agg.savings += session.totals.savings;
  agg.truncations += session.totals.truncations;
  agg.llmCalls += session.llmUsage.calls;
  agg.llmTokensUsed += session.llmUsage.tokensUsed;
}

function addAggregate(target: SourceAggregate, source: SourceAggregate): void {
  for (const key of Object.keys(target) as Array<keyof SourceAggregate>) {
    target[key] += source[key];
  }
}

function totalOf(bySource: SourceAggregates): SourceAggregate {
  const total = emptySourceAggregate();
  for (const agg of Object.values(bySource)) addAggregate(total, agg);
  return total;
}

/** Aggregate snapshots by source and across all sources. */
export function summarizeSessions(snapshots: SessionStatsSnapshot[]): HistorySummary {
  const bySource: SourceAggregates = {};
  for (const snapshot of snapshots) addSession(bySource, snapshot);
  return { persistedSessions: snapshots.length, bySource, total: totalOf(bySource) };
}

function contribution(snapshot: SessionContribution): SessionContribution {
  const { source, startedAt, totals, llmUsage } = snapshot;
  return { source, startedAt, totals, llmUsage };
}

function isCumulativeFile(value: unknown): value is CumulativeFile {
  const file = value as Partial<CumulativeFile> | null;
  return (
    typeof file === 'object' && file !== null && file.schemaVersion === 1 && typeof file.since === 'number' &&
    typeof file.retired === 'object' && file.retired !== null &&
    typeof file.sessions === 'object' && file.sessions !== null &&
    (file.evicted === undefined || (typeof file.evicted === 'object' && file.evicted !== null))
  );
}

/** Missing file → undefined; corrupted or unknown format → undefined with a warning. */
function readCumulativeFile(dir: string): CumulativeFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, CUMULATIVE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCumulativeFile(parsed)) return parsed;
  } catch {
    // Reported below.
  }
  console.warn(`graph-it stats: ignoring invalid cumulative totals file: ${CUMULATIVE_FILE}`);
  return undefined;
}

/**
 * Session files on disk are the truth for live sessions: the map is rebuilt
 * from them on every write, so a rewrite replaces its contribution and a
 * concurrent writer's lost update heals at the next write. Evicted sessions
 * stay keyed by file name, so folding them twice is idempotent and a file
 * that reappears (rewritten by its live process) replaces its old entry.
 */
function updateCumulative(dir: string, fallbackSince: number): void {
  const previous = readCumulativeFile(dir);
  const sessions: Record<string, SessionContribution> = {};
  let since = previous?.since ?? fallbackSince;
  for (const snapshot of readAllSessions(dir, true)) {
    sessions[sessionFileName(snapshot)] = contribution(snapshot);
    since = Math.min(since, snapshot.startedAt);
  }

  const evicted = { ...previous?.evicted };
  for (const [fileName, session] of Object.entries(previous?.sessions ?? {})) {
    if (!(fileName in sessions)) evicted[fileName] = session;
  }
  for (const fileName of Object.keys(sessions)) delete evicted[fileName];

  const retired = previous?.retired ?? {};
  const byAge = Object.entries(evicted).sort(([, a], [, b]) => a.startedAt - b.startedAt);
  for (const [fileName, session] of byAge.slice(0, Math.max(0, byAge.length - MAX_EVICTED_TRACKED))) {
    addSession(retired, session);
    delete evicted[fileName];
  }

  const file: CumulativeFile = { schemaVersion: 1, since, retired, evicted, sessions };
  writeAtomic(dir, CUMULATIVE_FILE, JSON.stringify(file));
}

/**
 * Read cumulative totals (every session ever written, rotation included).
 * Returns undefined when no session was written by a release that keeps them.
 *
 * @param baseDir override of the stats directory (tests); defaults to ~/.graph-it/stats
 */
export function readCumulative(baseDir?: string): CumulativeSummary | undefined {
  const file = readCumulativeFile(baseDir ?? getDefaultStatsDir());
  if (!file) return undefined;
  const bySource: SourceAggregates = {};
  for (const [source, agg] of Object.entries(file.retired)) {
    bySource[source as SessionStatsSource] = { ...emptySourceAggregate(), ...agg };
  }
  for (const session of [...Object.values(file.evicted ?? {}), ...Object.values(file.sessions)]) {
    addSession(bySource, session);
  }
  return { since: new Date(file.since).toISOString(), bySource, total: totalOf(bySource) };
}

// ---------------------------------------------------------------------------
// Periodic flush (long-running processes: MCP server, VS Code extension host)
// ---------------------------------------------------------------------------

export interface PeriodicFlush {
  /** Flush unsaved records now and stop listening. Idempotent. */
  dispose(): void;
}

export interface PeriodicFlushOptions {
  delayMs?: number;
  baseDir?: string;
  onError?: (error: unknown) => void;
}

/**
 * Rewrite the collector's session file at most `delayMs` after the first
 * unsaved record. Nothing is written while idle, and a killed process loses
 * at most the last `delayMs` of records.
 */
export function startPeriodicFlush(
  collector: SessionStatsCollector,
  { delayMs = PERIODIC_FLUSH_DELAY_MS, baseDir, onError }: PeriodicFlushOptions = {},
): PeriodicFlush {
  // Set only while records are unsaved.
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    try {
      flushSession(collector.snapshot(), baseDir);
    } catch (error) {
      onError?.(error);
    }
  };
  const unsubscribe = collector.onRecord(() => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    // Never keep a process alive only to flush stats.
    timer.unref();
  });
  return {
    dispose(): void {
      unsubscribe();
      if (timer) flush();
    },
  };
}
