/**
 * Workspaces of the units contract rows (ADR-776, CLI and MCP): written into a new temporary
 * folder, committed with git where a row reviews a diff. Neutral names only.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Files = Record<string, string>;

/** Writes `files` into a new temporary folder (realpath: macOS tmpdir is a symlink). */
export function writeWorkspace(prefix: string, files: Files): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  addFiles(root, files);
  return root;
}

export function addFiles(root: string, files: Files): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" }); // NOSONAR S4036 test fixture: git from the developer's PATH

export function commit(root: string, message: string): void {
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", message);
}

const config = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Elements alpha (src/alpha), beta (src/beta) and pkgs (packages/), one forbid rule alpha → beta.
 * Three commits: `base` with no cross import; `elements` where alpha and beta import each other
 * (one detected project, src: no detected-project cycle); `projects` where the detected projects
 * packages/p and packages/q, both inside pkgs, import each other.
 */
export function elementsWorkspace(): string {
  const root = writeWorkspace("graph-it-units-", {
    "package.json": '{ "name": "units", "private": true }\n',
    "src/alpha/x.ts": "export const x = () => 1;\n",
    "src/beta/y.ts": "export const y = () => 2;\n",
    "packages/p/package.json": '{ "name": "p" }\n',
    "packages/p/index.ts": "export const p = () => 1;\n",
    "packages/q/package.json": '{ "name": "q" }\n',
    "packages/q/index.ts": "export const q = () => 2;\n",
    "graphit.architecture.json": config({
      elements: { alpha: { path: "src/alpha/" }, beta: { path: "src/beta/" }, pkgs: { path: "packages/" } },
      rules: [{ name: "alpha-not-beta", from: "alpha", forbid: ["beta"], severity: "warning" }],
    }),
  });
  git(root, "init", "-q", "--initial-branch=main");
  commit(root, "base");
  addFiles(root, {
    "src/alpha/x.ts": 'import { y } from "../beta/y";\nexport const x = () => 1;\nexport const useY = () => y();\n',
    "src/beta/y.ts": 'import { x } from "../alpha/x";\nexport const y = () => x();\n',
  });
  commit(root, "elements");
  addFiles(root, {
    "packages/p/index.ts": 'import { q } from "../q/index";\nexport const p = () => q();\n',
    "packages/q/index.ts": 'import { p } from "../p/index";\nexport const q = () => 2;\nexport const useP = () => p();\n',
  });
  commit(root, "projects");
  return root;
}

/** Code at the workspace root, in scripts/ and in tools/, and `config` as graphit.architecture.json. */
export function rootWorkspace(configValue?: object): string {
  return writeWorkspace("graph-it-root-", {
    "package.json": '{ "name": "rooted", "private": true }\n',
    "index.ts": 'import { run } from "./scripts/run";\nexport const main = () => run();\n',
    "scripts/run.ts": 'import { tool } from "../tools/tool";\nexport const run = () => tool();\n',
    "tools/tool.ts": "export const tool = () => 1;\n",
    ...(configValue === undefined ? {} : { "graphit.architecture.json": config(configValue) }),
  });
}
