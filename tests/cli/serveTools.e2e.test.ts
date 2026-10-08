/**
 * Stdio smoke test of every MCP tool through the built `graph-it serve` (#242).
 *
 * Replaces scripts/test-mcp.js, which only counted responses: here the tool
 * inventory comes from tools/list, and any call that fails is a test failure
 * unless it is listed as an expected failure.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSession, startMcpSession } from "./mcpSession";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));

const HELPER_SOURCE = "export function helper() { return 1; }\n";

describe.skipIf(!distExists)("MCP tools over graph-it serve (E2E)", { timeout: 180_000 }, () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-tools-")));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src/b.ts"), HELPER_SOURCE);
    fs.writeFileSync(
      path.join(tmpDir, "src/a.ts"),
      'import { helper } from "./b";\nexport function run() { return helper(); }\n',
    );
    // review_pr diffs against a Git ref. Test-only fixture: git comes from PATH.
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: tmpDir }); // NOSONAR
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterAll(() => {
    // Windows releases a dead process's cwd with a delay.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("answers every listed tool without an unexpected error", async () => {
    const a = path.join(tmpDir, "src/a.ts");
    const b = path.join(tmpDir, "src/b.ts");
    // Ordered: set_workspace first, rebuild_index before the call graph tools.
    const calls: Record<string, Record<string, unknown>> = {
      graphitlive_set_workspace: { workspacePath: tmpDir },
      graphitlive_get_index_status: {},
      graphitlive_analyze_dependencies: { filePath: a },
      graphitlive_crawl_dependency_graph: { entryFile: a },
      graphitlive_find_referencing_files: { targetPath: b },
      graphitlive_verify_dependency_usage: { sourceFile: a, targetFile: b },
      graphitlive_resolve_module_path: { fromFile: a, moduleSpecifier: "./b" },
      graphitlive_invalidate_files: { filePaths: [a] },
      graphitlive_rebuild_index: {},
      graphitlive_get_symbol_graph: { filePath: a },
      graphitlive_find_unused_symbols: { filePath: b },
      graphitlive_trace_function_execution: { filePath: a, symbolName: "run" },
      graphitlive_analyze_breaking_changes: { filePath: b, oldContent: HELPER_SOURCE },
      graphitlive_review_pr: { baseRef: "HEAD" },
      graphitlive_get_impact_analysis: { filePath: b, symbolName: "helper" },
      graphitlive_generate_codemap: { filePath: a },
      graphitlive_query_call_graph: { filePath: b, symbolName: "helper" },
      graphitlive_scan_dead_code: {},
      graphitlive_graph_context: { question: "what calls helper" },
      graphitlive_query_natural_language: { question: "what calls helper" },
      graphitlive_generate_wiki: { outputDir: "wiki" },
      graphitlive_get_session_stats: {},
    };
    const { child, request, callTool } = await startMcpSession(DIST_ENTRY, tmpDir, tmpDir);
    try {
      const listed = (await request("tools/list", {})).result as { tools: Array<{ name: string }> };
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(calls).sort());

      const failures: string[] = [];
      for (const [name, args] of Object.entries(calls)) {
        const result = await callTool(name, { ...args, response_format: "json" });
        if (!result || result.isError) failures.push(`${name}: ${result?.content?.[0]?.text ?? "no result"}`);
      }
      expect(failures).toEqual([]);

      // A placeholder oldContent cannot be compared and must not look like "no breaking change" (#260).
      const placeholder = await callTool("graphitlive_analyze_breaking_changes", {
        filePath: b,
        symbolName: "helper",
        oldContent: "PLACEHOLDER",
      });
      expect(placeholder.isError).toBe(true);
      expect(placeholder.content[0].text).toContain("Symbol 'helper' is not declared in oldContent; cannot compare.");

      // An intended failure must still be reported as one.
      const missing = await callTool("graphitlive_analyze_dependencies", { filePath: path.join(tmpDir, "src/missing.ts") });
      expect(missing.isError).toBe(true);

      expect(await closeSession(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});
