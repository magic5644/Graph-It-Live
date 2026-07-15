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
 * - Snapshots contain no workspace paths nor code content by construction.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionStatsSnapshot } from '@/shared/sessionStats';

const MAX_FILES_PER_SOURCE = 50;

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

  const fileName = `${snapshot.source}-${snapshot.sessionId}.json`;
  const finalPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `.${fileName}.${process.pid}.tmp`);

  // Atomic write: temp file in the same directory, then rename.
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath);

  rotate(dir);
}

/**
 * Read all persisted session snapshots from the stats directory.
 *
 * - Missing directory → [] (covers "file absent" criterion).
 * - Corrupted / unreadable file → skipped with a stderr warning, never throws.
 *
 * @param baseDir override of the stats directory (tests); defaults to ~/.graph-it/stats
 */
export function readAllSessions(baseDir?: string): SessionStatsSnapshot[] {
  const dir = baseDir ?? getDefaultStatsDir();

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
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) {
        snapshots.push(parsed);
      } else {
        console.warn(`graph-it stats: skipping invalid stats file: ${name}`);
      }
    } catch {
      console.warn(`graph-it stats: skipping corrupted stats file: ${name}`);
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
