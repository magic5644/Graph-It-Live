import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SequenceDiskCache } from "../../../src/analyzer/sequence/cache/SequenceDiskCache.js";
import { buildSequenceCacheKey } from "../../../src/analyzer/sequence/cache/key.js";
import { SequenceMemoryCache } from "../../../src/analyzer/sequence/cache/SequenceMemoryCache.js";
import type { SequenceModel } from "../../../src/analyzer/sequence/types.js";

function createModel(symbolName: string): SequenceModel {
  return {
    root: {
      id: `/repo/src/index.ts:${symbolName}:0:0`,
      symbolName,
      filePath: "/repo/src/index.ts",
    },
    participants: [],
    messages: [],
    warnings: [],
    truncated: false,
    stats: {
      participantsCount: 0,
      messagesCount: 0,
      analysisTimeMs: 0,
    },
  };
}

describe("sequence cache key", () => {
  it("is deterministic", () => {
    const first = buildSequenceCacheKey({
      workspaceRoot: "/repo",
      filePath: "/repo/src/a.ts",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 50,
      includeExternal: true,
      includeAnnotations: true,
      engineVersion: "1",
    });

    const second = buildSequenceCacheKey({
      workspaceRoot: "/repo/",
      filePath: "/repo/src/a.ts",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 50,
      includeExternal: true,
      includeAnnotations: true,
      engineVersion: "1",
    });

    expect(first).toBe(second);
  });

  it("changes when version changes", () => {
    const v1 = buildSequenceCacheKey({
      workspaceRoot: "/repo",
      filePath: "/repo/src/a.ts",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 50,
      includeExternal: true,
      includeAnnotations: true,
      engineVersion: "1",
    });

    const v2 = buildSequenceCacheKey({
      workspaceRoot: "/repo",
      filePath: "/repo/src/a.ts",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 50,
      includeExternal: true,
      includeAnnotations: true,
      engineVersion: "2",
    });

    expect(v1).not.toBe(v2);
  });
});

describe("SequenceMemoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns values before TTL expiry", () => {
    const cache = new SequenceMemoryCache(1000, 5);
    const model = createModel("main");

    cache.set("k1", model);

    vi.advanceTimersByTime(900);

    expect(cache.get("k1")).toEqual(model);
  });

  it("evicts expired values", () => {
    const cache = new SequenceMemoryCache(1000, 5);
    const model = createModel("main");

    cache.set("k1", model);

    vi.advanceTimersByTime(1001);

    expect(cache.get("k1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("keeps bounded entries and evicts LRU", () => {
    const cache = new SequenceMemoryCache(10_000, 2);

    const one = createModel("one");
    const two = createModel("two");
    const three = createModel("three");

    cache.set("k1", one);
    cache.set("k2", two);

    cache.get("k1");

    cache.set("k3", three);

    expect(cache.get("k1")?.root.symbolName).toBe("one");
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.get("k3")?.root.symbolName).toBe("three");
    expect(cache.size).toBe(2);
  });
});

describe("SequenceDiskCache", () => {
  let tempWorkspaceRoot = "";

  beforeEach(() => {
    tempWorkspaceRoot = `tests/.tmp-sequence-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  afterEach(() => {
    const cache = new SequenceDiskCache(tempWorkspaceRoot);
    cache.clear();
  });

  it("persists cache entries under .graph-it/sequence-cache", () => {
    const cache = new SequenceDiskCache(tempWorkspaceRoot);
    const model = createModel("main");
    const key = "abc12345";

    cache.write(key, model);

    expect(cache.cacheDir).toContain(".graph-it");
    expect(cache.cacheDir).toContain("sequence-cache");
    expect(cache.read(key)).toEqual(model);
  });

  it("ignores invalid keys", () => {
    const cache = new SequenceDiskCache(tempWorkspaceRoot);
    const model = createModel("main");

    cache.write("../bad-key", model);

    expect(cache.read("../bad-key")).toBeUndefined();
    expect(cache.delete("../bad-key")).toBe(false);
  });
});
