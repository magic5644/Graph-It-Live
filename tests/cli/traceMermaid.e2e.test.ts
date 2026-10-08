/**
 * `trace --format mermaid` through the built CLI (#265): one node per full
 * symbol id, synthetic ids, workspace-relative labels, external symbols styled.
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
  "package.json": '{ "name": "trace-fixture", "version": "1.0.0" }',
  "src/x.ts": "export function x(): number { return 1; }\n",
  "src/a.ts": 'import { x } from "./x";\nexport function helper(): number { return x(); }\n',
  "src/b.ts": [
    'import { readFileSync } from "node:fs";',
    "export function end(): void {}",
    'export function helper(): string { end(); return readFileSync("f", "utf8"); }',
    "",
  ].join("\n"),
  "src/e.ts": [
    'import { helper as helperA } from "./a";',
    'import { helper as helperB } from "./b";',
    "export function entry(): void { helperA(); helperB(); }",
    "",
  ].join("\n"),
};

const EXPECTED = [
  "graph TD",
  '  S0["entry · src/e.ts"]',
  '  S1["helper · src/a.ts"]',
  '  S2["x · src/x.ts"]',
  '  S3["helper · src/b.ts"]',
  '  S4(["readFileSync · node:fs"]):::external',
  '  S5["end · src/b.ts"]',
  "  S0 --> S1",
  "  S1 --> S2",
  "  S0 --> S3",
  "  S3 --> S4",
  "  S3 --> S5",
  "  classDef external stroke-dasharray: 4 2",
].join("\n");

describe.skipIf(!distExists)("trace --format mermaid (E2E)", { timeout: 60_000 }, () => {
  let workspace: string;

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, "-w", workspace, ...args], { encoding: "utf-8" });

  beforeAll(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-trace-mermaid-")));
    for (const [relative, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
      fs.writeFileSync(path.join(workspace, relative), content);
    }
    expect(cli("scan").status).toBe(0);
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("matches the structured call chain node for node", () => {
    const json = cli("trace", "src/e.ts#entry", "--format", "json");
    expect(json.status).toBe(0);
    const { callChain } = JSON.parse(json.stdout) as {
      callChain: Array<{ callerSymbolId: string; calledSymbolId: string }>;
    };
    const tail = (id: string) => id.replaceAll("\\", "/").split("/src/").pop();
    expect(callChain.map((c) => `${tail(c.callerSymbolId)} -> ${tail(c.calledSymbolId)}`)).toEqual([
      "e.ts:entry -> a.ts:helper",
      "a.ts:helper -> x.ts:x",
      "e.ts:entry -> b.ts:helper",
      "b.ts:helper -> node:fs:readFileSync",
      "b.ts:helper -> b.ts:end",
    ]);

    const mermaid = cli("trace", "src/e.ts#entry", "--format", "mermaid");
    expect(mermaid.status).toBe(0);
    expect(mermaid.stdout.trimEnd()).toBe(EXPECTED);
  });

  it("embeds the same diagram in markdown output", () => {
    const markdown = cli("trace", "src/e.ts#entry", "--format", "markdown");
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain("```mermaid\n" + EXPECTED + "\n```");
  });
});
