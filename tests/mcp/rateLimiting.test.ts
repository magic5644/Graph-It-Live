import { describe, it, expect, beforeEach } from "vitest";

// mcpServer.ts connects a real stdio transport at import time (main().catch(...)
// runs top-level), so it cannot be imported directly in a unit test. This
// mirrors the sliding-window limiter in `checkRateLimit` (mcpServer.ts) to
// verify the algorithm — same convention as mcpLogRotation.test.ts.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_CALLS: Record<string, number> = {
  set_workspace: 5,
  rebuild_index: 5,
  invalidate_files: 20,
};

function makeRateLimiter() {
  const rateLimitCallTimestamps = new Map<string, number[]>();

  return (tool: string, now: number): string | null => {
    const max = RATE_LIMIT_MAX_CALLS[tool];
    if (max === undefined) return null;

    const recentCalls = (rateLimitCallTimestamps.get(tool) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );

    if (recentCalls.length >= max) {
      return `Rate limit exceeded: max ${max} calls per ${RATE_LIMIT_WINDOW_MS / 1000}s for ${tool}. Wait before retrying.`;
    }

    recentCalls.push(now);
    rateLimitCallTimestamps.set(tool, recentCalls);
    return null;
  };
}

describe("MCP rate limiting (checkRateLimit sliding window)", () => {
  let checkRateLimit: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    checkRateLimit = makeRateLimiter();
  });

  it("allows calls under the per-tool limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("set_workspace", now)).toBeNull();
    }
  });

  it("blocks the call once the limit is exceeded within the window", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) checkRateLimit("rebuild_index", now);

    const result = checkRateLimit("rebuild_index", now);
    expect(result).toContain("Rate limit exceeded");
    expect(result).toContain("rebuild_index");
  });

  it("allows calls again once the window has elapsed", () => {
    const start = Date.now();
    for (let i = 0; i < 5; i++) checkRateLimit("set_workspace", start);
    expect(checkRateLimit("set_workspace", start)).not.toBeNull();

    const afterWindow = start + RATE_LIMIT_WINDOW_MS + 1;
    expect(checkRateLimit("set_workspace", afterWindow)).toBeNull();
  });

  it("tracks limits independently per tool", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) checkRateLimit("set_workspace", now);

    expect(checkRateLimit("set_workspace", now)).not.toBeNull();
    expect(checkRateLimit("invalidate_files", now)).toBeNull();
  });

  it("applies the higher call budget for invalidate_files", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit("invalidate_files", now)).toBeNull();
    }
    expect(checkRateLimit("invalidate_files", now)).not.toBeNull();
  });

  it("does not rate-limit tools outside the configured map", () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit("get_index_status", now)).toBeNull();
    }
  });
});
