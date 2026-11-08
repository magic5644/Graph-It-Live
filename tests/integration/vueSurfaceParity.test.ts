/**
 * Vue SFC parity (#644): the CLI binary and the MCP tool answer the same script-level call graph queries with the
 * same targets and the positions of the `.vue` files. Each surface builds its own index, as in production.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { indexWorkspace, REPO_ROOT, wasmBuilt } from "../mcp/tools/callGraphWorkspace";

const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const FIXTURES = path.resolve(__dirname, "../analyzer/fixtures/vue");
const QUERIES = ["ScriptSetupTs.vue#total", "TwoBlocks.vue#capped", "OptionsApi.vue#run", "TsxSetup.vue#Badge", "utils/math.ts#add"];

interface CallEdge { relation: string; sourceLine: number; sourceName: string; sourceFile: string; targetName: string; targetFile: string }
interface CallGraphAnswer { symbol: { name: string; filePath: string; startLine: number; endLine: number } | null; reason?: string; callers: CallEdge[]; callees: CallEdge[] }

/** The fixtures under src/, with the `@/` alias rooted there. */
function corpus(): Record<string, string> {
  const files: Record<string, string> = { "../tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }' };
  for (const name of fs.readdirSync(FIXTURES, { recursive: true }) as string[]) {
    const file = path.join(FIXTURES, name);
    if (fs.statSync(file).isFile() && !name.endsWith(".json")) files[name.replaceAll("\\", "/")] = fs.readFileSync(file, "utf8");
  }
  return files;
}

/** Every answer as `query: fact` lines, with 1-based lines and workspace-relative paths. */
async function answers(root: string, callGraph: (filePath: string, symbolName: string) => Promise<CallGraphAnswer>): Promise<string[]> {
  const rel = (file: string) => (path.isAbsolute(file) ? path.relative(root, file) : file).replaceAll("\\", "/");
  const edge = (e: CallEdge) => `${rel(e.sourceFile)}#${e.sourceName} -${e.relation}@${e.sourceLine + 1}-> ${rel(e.targetFile)}#${e.targetName}`;
  const lines: string[] = [];
  for (const key of QUERIES) {
    const [file, symbolName] = key.split("#");
    // One query after the other: the CLI spawns one process per query.
    const { symbol, reason, callers, callees } = await callGraph(path.join(root, "src", file), symbolName); // NOSONAR S9382: sequential CLI processes
    lines.push(`${key} symbol: ${symbol ? `${rel(symbol.filePath)}#${symbol.name}@${symbol.startLine + 1}-${symbol.endLine + 1}` : reason}`,
      ...callers.map((e) => `${key} caller: ${edge(e)}`), ...callees.map((e) => `${key} callee: ${edge(e)}`));
  }
  return lines.sort();
}

describe.skipIf(!wasmBuilt || !fs.existsSync(DIST_ENTRY))("Vue SFC parity across CLI and MCP (#644)", { timeout: 300_000 }, () => {
  let mcp: { tmpDir: string; runtime: CliRuntime };

  beforeAll(async () => {
    mcp = await indexWorkspace("vue-parity-", corpus());
  }, 120_000);
  afterAll(async () => {
    await mcp.runtime.dispose();
    fs.rmSync(mcp.tmpDir, { recursive: true, force: true });
  }, 60_000);

  it("answers the same call graph queries with the same targets and .vue positions", async () => {
    const mcpAnswers = await answers(mcp.tmpDir, (filePath, symbolName) =>
      executeQueryCallGraph({ filePath, symbolName, direction: "both", depth: 1 }) as Promise<CallGraphAnswer>);

    expect(mcpAnswers).toEqual(expect.arrayContaining([
      "ScriptSetupTs.vue#total symbol: src/ScriptSetupTs.vue#total@10-12",
      "ScriptSetupTs.vue#total callee: src/ScriptSetupTs.vue#total -CALLS@11-> src/utils/math.ts#add",
      "TwoBlocks.vue#capped symbol: src/TwoBlocks.vue#capped@12-14",
      "OptionsApi.vue#run callee: src/OptionsApi.vue#run -CALLS@12-> src/utils/math.ts#add",
      "TsxSetup.vue#Badge callee: src/TsxSetup.vue#Badge -CALLS@4-> src/utils/math.ts#add",
      "utils/math.ts#add caller: src/TwoBlocks.vue#capped -CALLS@13-> src/utils/math.ts#add",
    ]));

    const cliRoot = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(mcp.tmpDir), "vue-cli-")));
    try {
      fs.cpSync(mcp.tmpDir, cliRoot, { recursive: true, filter: (src) => !src.includes(".graph-it") });
      const cli = (filePath: string, symbolName: string) => {
        const out = execFileSync(process.execPath, [DIST_ENTRY, "tool", "query_call_graph", `--filePath=${filePath}`, `--symbolName=${symbolName}`,
          "--direction=both", "--depth=1", "-w", cliRoot, "--format", "json"], { cwd: cliRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        return Promise.resolve(JSON.parse(out.slice(out.indexOf("{"))) as CallGraphAnswer);
      };
      expect(await answers(cliRoot, cli)).toEqual(mcpAnswers);
    } finally {
      fs.rmSync(cliRoot, { recursive: true, force: true });
    }
  });
});
