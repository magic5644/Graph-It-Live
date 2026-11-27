/** `diagram --delta` and `review-pr --deltaSvg` (#449) through the built binary, on a real two-commit Git repository. */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST_ENTRY = path.resolve(__dirname, "../../dist/graph-it.js");
const TIMEOUT_MS = 120_000;
let root = "";

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const cli = (args: string[]) => spawnSync(process.execPath, [DIST_ENTRY, ...args, "--workspace", root], { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS });

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "delta-e2e-"));
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Delta E2E");
  write("package.json", '{ "name": "shop", "private": true }\n');
  write("orders/service.ts", 'import { charge } from "../billing/invoice";\nexport const place = charge;\n');
  write("billing/invoice.ts", 'export const charge = 1;\n');
  write("app/main.ts", 'import { place } from "../orders/service";\nexport const main = place;\n');
  git("add", ".");
  git("commit", "-m", "base");
  git("tag", "v-base");
  write("shipping/ship.ts", 'import { place } from "../orders/service";\nexport const ship = place;\n');
  write("billing/invoice.ts", 'import { place } from "../orders/service";\nexport const charge = place;\n');
  git("add", ".");
  git("commit", "-m", "head");
}, TIMEOUT_MS);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!fs.existsSync(DIST_ENTRY))("diagram --delta (built CLI)", () => {
  it("writes architecture-delta.svg for a changed comparison, to stdout with --output -", () => {
    const written = cli(["diagram", "--delta", "--base", "v-base"]);
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toMatch(/^Diagram written to architecture-delta\.svg: units \d+ -> \d+/);
    const svg = fs.readFileSync(path.join(root, "architecture-delta.svg"), "utf8");
    expect(svg).toContain('data-diagram="architecture-delta"');
    expect(svg).toContain("shipping");
    const stdout = cli(["diagram", "--delta", "--base", "v-base", "--output", "-", "--theme", "dark"]);
    expect(stdout.status).toBe(0);
    expect(stdout.stdout).toMatch(/^<svg /);
  }, TIMEOUT_MS);

  it("an unchanged comparison writes nothing and exits 0", () => {
    const result = cli(["diagram", "--delta", "--base", "v-base", "--head", "v-base", "--output", "same.svg"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No architecture change between v-base and v-base");
    expect(fs.existsSync(path.join(root, "same.svg"))).toBe(false);
    const piped = cli(["diagram", "--delta", "--base", "v-base", "--head", "v-base", "--output", "-"]);
    expect([piped.status, piped.stdout]).toEqual([0, ""]);
    expect(piped.stderr).toContain("no diagram written");
  }, TIMEOUT_MS);

  it.each([
    [["--delta"], 1, "--delta compares two refs: pass --base <git-ref>"],
    [["--base", "v-base"], 1, "--base and --head apply to --delta"],
    [["--delta", "--base", "v-base", "--view", "units"], 1, "--delta draws the structure diff of two refs: drop --view"],
    [["--delta", "--base", "v-base", "src"], 1, "drop src"],
    [["--delta", "--base", "nope"], 1, 'Unknown Git ref "nope": pass a branch, tag or commit of this repository.'],
    [["--delta", "--base", "v-base", "--format", "html"], 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "v-base", "--format", "mermaid"], 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "v-base", "--format", "diagram-spec"], 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "v-base", "--format", "json"], 4, "graph-it diagram does not write --format json"],
    [["--delta", "--base", "v-base", "--output", "x.html"], 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "v-base", "--format", "svg", "--output", "x.json"], 1, "--output x.json does not match --format svg"],
    [["--delta", "--base", "v-base", "--theme", "blue"], 1, "--theme must be light or dark"],
    [["--delta", "--base", "v-base", "--output", "../x.svg"], 5, "Refusing to write ../x.svg"],
  ])("diagram %j exits %i with a one-line message", (args, status, message) => {
    const result = cli(["diagram", ...args]);
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("Command failed");
  }, TIMEOUT_MS);

  it("review-pr --deltaSvg writes the diagram next to a JSON review, and refuses a bad value", () => {
    const result = cli(["review-pr", "--base", "v-base", "--deltaSvg", "out/review.svg", "--format", "json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).structure.verdict).toBe("changed");
    expect(fs.readFileSync(path.join(root, "out", "review.svg"), "utf8")).toContain('data-diagram="architecture-delta"');
    for (const [value, status] of [["-", 1], ["x.png", 1], ["../x.svg", 5]] as const) {
      expect(cli(["review-pr", "--base", "v-base", "--deltaSvg", value]).status, value).toBe(status);
    }
    const unchanged = cli(["review-pr", "--base", "v-base", "--head", "v-base", "--deltaSvg", "none.svg", "--format", "json"]);
    expect(unchanged.status).toBe(0);
    expect(fs.existsSync(path.join(root, "none.svg"))).toBe(false);
  }, TIMEOUT_MS);
});
