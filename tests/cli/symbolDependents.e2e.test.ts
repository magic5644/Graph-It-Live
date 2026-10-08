/**
 * Symbol dependents through the built CLI (#259): same-file callers and
 * namespace-import usages count, and an unknown symbol is an error.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY);

const FILES: Record<string, string> = {
  "package.json": '{ "name": "fx", "version": "0.0.0", "type": "module" }',
  "src/core.ts": [
    "export function target(x: number): number {",
    "  return x * 2;",
    "}",
    "",
    "export class Service {",
    "  run(): number {",
    "    return target(21);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/named.ts": 'import { target } from "./core";\nexport const viaNamed = () => target(1);\n',
  "src/ns.ts": 'import * as core from "./core";\nexport const viaNamespace = () => core.target(2);\n',
  "src/ns.test.ts": 'import * as core from "./core";\nimport { vi } from "vitest";\nexport const spy = vi.spyOn(core, "target");\n',
};

describe.skipIf(!distExists)("symbol dependents (E2E)", { timeout: 60_000 }, () => {
  let workspace: string;
  let core: string;

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, "-w", workspace, ...args, "--format", "json"], { encoding: "utf-8" });
  const sourceNames = (ids: string[]) => ids.map((id) => id.split(":").pop()).sort();

  beforeAll(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-dependents-")));
    for (const [relative, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
      fs.writeFileSync(path.join(workspace, relative), content);
    }
    core = path.join(workspace, "src", "core.ts");
    expect(cli("scan").status).toBe(0);
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("get_symbol_dependents counts same-file, named, namespace and spyOn dependents", () => {
    const result = cli("tool", "get_symbol_dependents", `--filePath=${core}`, "--symbolName=target");

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { dependentCount: number; dependents: Array<{ sourceSymbolId: string }> };
    expect(output.dependentCount).toBe(4);
    expect(sourceNames(output.dependents.map((d) => d.sourceSymbolId))).toEqual(["Service", "spy", "viaNamed", "viaNamespace"]);
  });

  it("get_impact_analysis reports the same four dependents", () => {
    const result = cli("tool", "get_impact_analysis", `--filePath=${core}`, "--symbolName=target");

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { totalImpactCount: number; impactedItems: Array<{ symbolId: string }> };
    expect(output.totalImpactCount).toBe(4);
    expect(sourceNames(output.impactedItems.map((i) => i.symbolId))).toEqual(["Service", "spy", "viaNamed", "viaNamespace"]);
  });

  it.each(["get_symbol_dependents", "get_impact_analysis"])("%s fails for an unknown symbol", (tool) => {
    const result = cli("tool", tool, `--filePath=${core}`, "--symbolName=doesNotExist");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Symbol 'doesNotExist' not found in src/core.ts");
  });
});
