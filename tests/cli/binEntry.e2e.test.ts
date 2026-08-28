/**
 * E2E regression test for the npm bin entry point.
 *
 * Root cause of the bug this guards against: `src/cli/index.ts` gates its
 * `main()` call behind `if (require.main === module)`. That check only
 * holds when `dist/graph-it.js` is the process's *own* entry point. A thin
 * wrapper script doing `require('../dist/graph-it.js')` (the old
 * `bin/graph-it`) makes `require.main` the *wrapper's* module instead — so
 * the guard is false, `main()` never runs, and the CLI silently exits 0 with
 * no output. This only reproduces against the built artifact; importing
 * `src/cli/index.ts` via Vitest never exercises it.
 *
 * Fix: npm's `bin` field points straight at `dist/graph-it.js` (no wrapper
 * indirection) — see package.json `bin.graph-it`. This test pins both sides:
 * the packaging config itself, and that the built entry actually produces
 * output when invoked the way npm invokes `bin` entries (as its own process
 * entry point, not `require()`d from another script).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY);

describe.skipIf(!distExists)("CLI bin entry point (E2E)", () => {
  beforeAll(() => {
    if (!distExists) {
      // eslint-disable-next-line no-console
      console.warn(`Skipping binEntry.e2e.test.ts: ${DIST_ENTRY} not built. Run "npm run build:cli" first.`);
    }
  });

  it("package.json bin field points directly at dist/graph-it.js (no wrapper indirection)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    // A wrapper (e.g. "./bin/graph-it" doing require('../dist/graph-it.js'))
    // breaks the require.main === module guard in src/cli/index.ts — see
    // module doc comment above.
    expect(pkg.bin["graph-it"]).toBe("./dist/graph-it.js");
  });

  it("prints the version when run directly as the process entry point", () => {
    const out = execFileSync(process.execPath, [DIST_ENTRY, "--version"], { encoding: "utf-8" });
    expect(out).toMatch(/graph-it-live v/);
  });

  it("prints usage help when run directly as the process entry point", () => {
    const out = execFileSync(process.execPath, [DIST_ENTRY, "--help"], { encoding: "utf-8" });
    expect(out).toContain("Usage:");
  });
});
