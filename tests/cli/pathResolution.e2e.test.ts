/**
 * Relative file paths must be read from the workspace they were validated
 * against, never from the process cwd (GHSA-2pv3-2vx4-vf28, CWE-22).
 *
 * Two directories hold a different `probe.ts`; the CLI and the MCP server run
 * from `outside/` with `--workspace workspace/`.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));

const WORKSPACE_PROBE = 'import { w } from "./workspace-only";\nexport function kept() { return w; }\n';
const OUTSIDE_PROBE = 'import { o } from "./outside-only";\nexport function other() { return o; }\n';

describe.skipIf(!distExists)("relative file paths resolve against the workspace (E2E)", { timeout: 60_000 }, () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-paths-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    for (const [dir, probe] of [[workspace, WORKSPACE_PROBE], [outside, OUTSIDE_PROBE]]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.writeFileSync(path.join(dir, "probe.ts"), probe);
    }
  });

  afterEach(() => {
    // Windows releases a dead process's cwd with a delay.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, "-w", workspace, ...args], { cwd: outside, encoding: "utf-8" });

  it("tool parse_imports reads the workspace file", () => {
    const result = cli("tool", "parse_imports", "--filePath=probe.ts", "--format", "json");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("./workspace-only");
    expect(result.stdout).not.toContain("./outside-only");
  });

  it("tool analyze_breaking_changes compares against the workspace file", () => {
    const result = cli("tool", "analyze_breaking_changes", "--filePath=probe.ts", `--oldContent=${WORKSPACE_PROBE}`, "--format", "json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).breakingChangeCount).toBe(0);
  });

  it("serve analyze_breaking_changes compares against the workspace file", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY, "serve", "--workspace", workspace], {
      cwd: outside,
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      let buffer = "";
      const response = (id: number) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const onData = () => {
            for (const line of buffer.split("\n")) {
              if (!line.startsWith("{")) continue;
              const message = JSON.parse(line) as { id?: number };
              if (message.id === id) {
                child.stdout.off("data", onData);
                resolve(message);
                return;
              }
            }
          };
          child.stdout.on("data", (chunk: string) => { buffer += chunk; });
          child.stdout.on("data", onData);
        });
      child.stdout.setEncoding("utf-8");
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
      });
      await response(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "graphitlive_analyze_breaking_changes",
          arguments: { filePath: "probe.ts", oldContent: WORKSPACE_PROBE, response_format: "json" },
        },
      });
      const result = (await response(2)).result as { structuredContent: { data: { breakingChangeCount: number } } };

      expect(result.structuredContent.data.breakingChangeCount).toBe(0);
    } finally {
      // Let the server finish writing its cache before afterEach removes the workspace.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (child.exitCode === null) child.kill();
    }
  });
});

/** tsconfig alias variants from #262; `tsc` resolves every one of them. */
const ALIAS_FIXTURES: Array<{ name: string; specifier: string; files: Record<string, string> }> = [
  { name: "@/* alias", specifier: "@/lib/x", files: { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }' } },
  { name: "~/* alias", specifier: "~/lib/x", files: { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"] } } }' } },
  { name: "src/* alias", specifier: "src/lib/x", files: { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "src/*": ["src/*"] } } }' } },
  {
    name: "JSONC tsconfig",
    specifier: "@/lib/x",
    files: { "tsconfig.json": '{\n  // generated by tsc --init\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["src/*"], },\n  },\n}' },
  },
  {
    name: "array extends",
    specifier: "@/lib/x",
    files: {
      "tsconfig.json": '{ "extends": ["./tsconfig.base.json"] }',
      "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    },
  },
  {
    name: "package extends",
    specifier: "@/lib/x",
    files: {
      "tsconfig.json": '{ "extends": "@acme/tsconfig/base.json" }',
      "node_modules/@acme/tsconfig/package.json": '{ "name": "@acme/tsconfig", "version": "1.0.0" }',
      "node_modules/@acme/tsconfig/base.json": '{ "compilerOptions": { "baseUrl": "../../../", "paths": { "@/*": ["src/*"] } } }',
    },
  },
];

describe.skipIf(!distExists)("tsconfig path aliases are indexed (E2E)", { timeout: 60_000 }, () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-alias-")));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [DIST_ENTRY, "-w", workspace, ...args, "--format", "json"], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  it.each(ALIAS_FIXTURES)("$name: indexed edges survive a warm cache and match resolve_module_path", ({ specifier, files }) => {
    const all: Record<string, string> = {
      "package.json": '{ "name": "fx", "version": "0.0.0" }',
      "src/lib/x.ts": "export const x = 1;\n",
      "src/main.ts": `import { x } from "${specifier}";\nexport const y = x + 1;\n`,
      ...files,
    };
    for (const [relative, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
      fs.writeFileSync(path.join(workspace, relative), content);
    }
    const main = path.join(workspace, "src", "main.ts");
    const target = path.join(workspace, "src", "lib", "x.ts");

    // Cold scan builds and persists the index; the second scan must reuse it.
    expect(cli("scan").warmup).toMatchObject({ fromCache: false });
    expect(cli("scan").warmup).toMatchObject({ fromCache: true });

    const deps = cli("tool", "analyze_dependencies", `--filePath=${main}`) as {
      dependencyCount: number;
      dependencies: Array<{ module: string; relativePath?: string }>;
    };
    const referencing = cli("tool", "find_referencing_files", `--targetPath=${target}`) as {
      referencingFiles: Array<{ relativePath: string; module: string }>;
    };
    const resolved = cli("tool", "resolve_module_path", `--fromFile=${main}`, `--moduleSpecifier=${specifier}`);

    expect(deps.dependencyCount).toBe(1);
    expect(deps.dependencies[0]).toMatchObject({ module: specifier, relativePath: "src/lib/x.ts" });
    expect(referencing.referencingFiles).toEqual([expect.objectContaining({ relativePath: "src/main.ts", module: specifier })]);
    expect(resolved).toMatchObject({ resolved: true, resolvedRelativePath: "src/lib/x.ts" });
  });
});
