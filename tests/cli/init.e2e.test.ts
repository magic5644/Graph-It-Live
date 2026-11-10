/**
 * E2E coverage for `graph-it init`: the config it writes from the built bundle, with the real
 * dead-code scan, makes `graph-it check-architecture` pass, and new drift fail.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRulesWorkspace } from "../analyzer/architecture/rulesWorkspace";

const DIST_ENTRY = path.resolve(__dirname, "../../dist/graph-it.js");

describe.skipIf(!fs.existsSync(DIST_ENTRY))("graph-it init (E2E)", { timeout: 120_000 }, () => {
  let root: string;
  const cli = (...args: string[]) => spawnSync(process.execPath, [DIST_ENTRY, "-w", root, "--no-cache", ...args], { encoding: "utf-8" });
  const check = () => {
    const { status, stdout } = cli("check-architecture", "--format", "json");
    return { status, report: JSON.parse(stdout) };
  };
  /** Adds a file for one check, then removes it. */
  const withFile = (file: string, content: string, test: () => void) => {
    fs.writeFileSync(path.join(root, file), content);
    try {
      test();
    } finally {
      fs.rmSync(path.join(root, file));
    }
  };

  beforeAll(() => {
    root = createRulesWorkspace(false);
    const { status, stdout, stderr } = cli("init", "--format", "json");
    expect(stderr).not.toMatch(/Error/);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "created", written: ["graphit.architecture.json"] });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes check-architecture with 0 violations and 0 unmatched files", () => {
    expect(check()).toMatchObject({ status: 0, report: { passed: true, totals: { violations: 0, unmatchedFiles: 0 } } });
  });

  it("fails on a new import between two units that were not connected", () => {
    withFile("mfe/checkout/src/extra.ts", 'import { mail } from "../../../functions/mail/index";\nexport const extra = () => mail();\n', () => {
      const { status, report } = check();
      expect(status).toBe(1);
      expect(report.violations).toEqual([expect.objectContaining({ rule: "mfe-checkout-imports", source: "mfe/checkout/src/extra.ts", new: true })]);
    });
  });

  it("fails on a new cycle between two units", () => {
    // frontend already imports backend.
    withFile("backend/src/loop.ts", 'import { app } from "../../frontend/src/app";\nexport const loop = () => app();\n', () => {
      const { status, report } = check();
      expect(status).toBe(1);
      expect(report.violations.map((violation: { rule: string }) => violation.rule)).toEqual(expect.arrayContaining(["backend-imports", "no-new-unit-cycles"]));
    });
  });

  it("reports the real dead-code scan and leaves the config alone on a second run", () => {
    const { status, stdout } = cli("init", "--format", "json");
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ status: "unchanged", written: [] });
    expect(result.assessment.totals.unusedExports).toBeGreaterThan(0);
  });
});
