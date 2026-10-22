/**
 * E2E coverage for `graph-it check-architecture`: the exit code and the report printed before the
 * error are set in `main()` (`src/cli/index.ts`), which only runs from the built bundle.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRulesWorkspace } from "../analyzer/architecture/rulesWorkspace";

const DIST_ENTRY = path.resolve(__dirname, "../../dist/graph-it.js");

describe.skipIf(!fs.existsSync(DIST_ENTRY))("graph-it check-architecture (E2E)", { timeout: 60_000 }, () => {
  let root: string;
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, "-w", root, "--no-cache", "check-architecture", ...args], { encoding: "utf-8" });

  beforeAll(() => {
    root = createRulesWorkspace();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prints the SARIF report and exits with 1 on new error violations", () => {
    const { status, stdout, stderr } = cli("--format", "sarif");
    expect(status).toBe(1);
    expect(stderr).toContain("5 error violation(s) of the architecture rules not in the baseline");
    expect(JSON.parse(stdout).runs[0].results).toHaveLength(6);
  });

  it("exits with 0 once the baseline accepts every violation", () => {
    expect(cli("--update-baseline").status).toBe(0);
    const { status, stdout } = cli("--format", "json");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ passed: true, totals: { violations: 6, newViolations: 0 } });
  });
});
