/**
 * CLI Version Check Helpers
 *
 * Shared logic to query npm registry for latest CLI version and optionally
 * notify users at startup with local cooldown caching.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

const NPM_PACKAGE = '@magic5644/graph-it-live';
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const CHECK_CACHE_FILE = path.join('.graph-it', 'update-check.json');
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCheckCache {
  checkedAt: number;
  latestVersion?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(version);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre);
}

function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function readCache(workspaceRoot: string): UpdateCheckCache | null {
  try {
    const cachePath = path.join(workspaceRoot, CHECK_CACHE_FILE);
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UpdateCheckCache>;
    if (typeof parsed.checkedAt !== 'number') return null;
    if (parsed.latestVersion !== undefined && typeof parsed.latestVersion !== 'string') {
      return null;
    }
    return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
  } catch {
    return null;
  }
}

function writeCache(workspaceRoot: string, cache: UpdateCheckCache): void {
  try {
    const cachePath = path.join(workspaceRoot, CHECK_CACHE_FILE);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // best-effort cache only
  }
}

/** Basic semver validation — rejects malformed strings. */
export function isValidVersion(version: string): boolean {
  return /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.test(version);
}

/** Fetch latest version string from npm registry. */
export function fetchLatestVersion(timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(REGISTRY_URL, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`npm registry returned HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
          const version = body['version'];
          if (typeof version !== 'string' || !isValidVersion(version)) {
            reject(new Error('Unexpected or invalid version from npm registry'));
            return;
          }
          resolve(version);
        } catch {
          reject(new Error('Failed to parse npm registry response'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Registry request timed out'));
    });
  });
}

export async function checkForCliUpdate(options: {
  workspaceRoot: string;
  currentVersion: string;
  minIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ updateAvailable: boolean; latestVersion?: string }> {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_INTERVAL_MS;
  const now = Date.now();
  const cache = readCache(options.workspaceRoot);

  if (cache && now - cache.checkedAt < minIntervalMs) {
    if (cache.latestVersion && isNewerVersion(cache.latestVersion, options.currentVersion)) {
      return { updateAvailable: true, latestVersion: cache.latestVersion };
    }
    return { updateAvailable: false, latestVersion: cache?.latestVersion };
  }

  const latest = await fetchLatestVersion(options.timeoutMs ?? 1500);
  writeCache(options.workspaceRoot, {
    checkedAt: now,
    latestVersion: latest,
  });

  if (isNewerVersion(latest, options.currentVersion)) {
    return { updateAvailable: true, latestVersion: latest };
  }

  return { updateAvailable: false, latestVersion: latest };
}

export async function maybeNotifyCliUpdate(options: {
  workspaceRoot: string;
  currentVersion: string;
  write?: (message: string) => void;
}): Promise<void> {
  if (process.env['GRAPH_IT_DISABLE_UPDATE_CHECK'] === '1') {
    return;
  }

  if (options.currentVersion === '0.0.0-dev') {
    return;
  }

  try {
    const check = await checkForCliUpdate({
      workspaceRoot: options.workspaceRoot,
      currentVersion: options.currentVersion,
    });

    if (!check.updateAvailable || !check.latestVersion) {
      return;
    }

    const write = options.write ?? ((message: string) => process.stderr.write(message));
    write(`Update available: v${check.latestVersion} (current: v${options.currentVersion}). Run: graph-it update\n`);
  } catch {
    // Silent on purpose: startup must never fail on network issues.
  }
}
