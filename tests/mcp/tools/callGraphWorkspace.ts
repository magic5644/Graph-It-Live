/** Throwaway workspace with a real CliRuntime (Spider + call graph WASM) for call graph tests. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LanguageService } from "@/analyzer/LanguageService";
import { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";

// The call graph parsers load from dist/wasm (built before the tests in CI).
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const wasmBuilt = fs.existsSync(path.join(REPO_ROOT, "dist/wasm/sqljs.wasm"));

/** Rewrite a file without moving its mtime: only an explicit invalidation can notice. */
export function rewriteKeepingMtime(filePath: string, content: string): void {
  const { atime, mtime } = fs.statSync(filePath);
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, atime, mtime);
}

/** Create `<tmp>/src/<name>` for each entry of `files`, then index the workspace. */
export async function indexWorkspace(
  prefix: string,
  files: Record<string, string>,
): Promise<{ tmpDir: string; runtime: CliRuntime }> {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(tmpDir, "src"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, "src", name), content);

  LanguageService.reset();
  const runtime = new CliRuntime(tmpDir);
  await runtime.init();
  // Under Vitest the runtime derives its package root from src/, not dist/.
  workerState.config = { ...workerState.getConfig(), extensionPath: REPO_ROOT };
  await runtime.ensureIndexed({ silent: true });
  return { tmpDir, runtime };
}
