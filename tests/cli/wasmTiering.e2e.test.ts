/**
 * The CLI and the MCP server call applyWasmTiering() in their main(), which only runs when the built bundle is the
 * process entry point (#800). An unknown GRAPH_IT_WASM_TIERING value prints a warning on stderr, which proves each
 * entry reaches the call; the memory effect itself is measured in the PR table.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const MCP_ENTRY = path.join(REPO_ROOT, "dist/mcpServer.mjs");
const SUBPROCESS_TIMEOUT_MS = 60_000;
const WARNING = 'Graph-It-Live: GRAPH_IT_WASM_TIERING=bogus is not "liftoff" or "default"; using ';

function stderrOf(entry: string, args: string[], value: string): string {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GRAPH_IT_WASM_TIERING: value, WORKSPACE_ROOT: REPO_ROOT },
    input: "", // the MCP server exits when stdin closes
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return result.stderr;
}

describe.skipIf(!fs.existsSync(CLI_ENTRY) || !fs.existsSync(MCP_ENTRY))(
  "GRAPH_IT_WASM_TIERING in the built entries (E2E)",
  { timeout: SUBPROCESS_TIMEOUT_MS },
  () => {
    it("the CLI warns on an unknown value and still runs", () => {
      expect(stderrOf(CLI_ENTRY, ["--version"], "bogus")).toContain(WARNING);
    });

    it("the MCP server warns on an unknown value on stderr", () => {
      expect(stderrOf(MCP_ENTRY, [], "bogus")).toContain(WARNING);
    });

    it("graph-it serve warns once: its MCP server child warns, the parent CLI leaves it to the child", () => {
      expect(stderrOf(CLI_ENTRY, ["serve"], "bogus").split(WARNING)).toHaveLength(2);
    });

    it.each(["liftoff", "default"])("neither entry warns for %s", (value) => {
      expect(stderrOf(CLI_ENTRY, ["--version"], value)).not.toContain("GRAPH_IT_WASM_TIERING");
      expect(stderrOf(MCP_ENTRY, [], value)).not.toContain("GRAPH_IT_WASM_TIERING");
    });
  },
);
