import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchWatchAnalyzer, parseRenames, RENAME_LIMIT, renameKey } from "@/analyzer/BranchWatchAnalyzer";

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix} line ${index} of the file\n`).join("");

function repository(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "renames-")));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("parseRenames", () => {
  const keep = renameKey;

  it("reads `R<score>` records into base -> head", () => {
    const moves = new Map<string, string>();
    expect(parseRenames("R100\0a.ts\0b.ts\0R055\0c/d.ts\0e/f.ts\0", moves, keep)).toBe(true);
    expect([...moves]).toEqual([["a.ts", "b.ts"], ["c/d.ts", "e/f.ts"]]);
  });

  it("reads empty output as complete and empty", () => {
    expect(parseRenames("", new Map(), keep)).toBe(true);
  });

  it.each([
    ["truncated last field", "R100\0a.ts\0b.ts"],
    ["odd field count", "R100\0a.ts\0"],
    ["unknown status", "M\0a.ts\0b.ts\0"],
    ["copy status", "C100\0a.ts\0b.ts\0"],
    ["missing terminator", "R100\0a.ts"],
  ])("refuses unparseable output: %s", (_name, output) => {
    expect(parseRenames(output, new Map(), keep)).toBe(false);
  });

  it("drops an entry whose path is absolute or leaves the repository, keeping the others", () => {
    const moves = new Map<string, string>();
    expect(parseRenames("R100\0a.ts\0../x.ts\0R100\0/etc/passwd\0z.ts\0R100\0ok.ts\0new.ts\0", moves, keep)).toBe(true);
    expect([...moves]).toEqual([["ok.ts", "new.ts"]]);
  });

  it.each([["..\\x.ts"], ["C:\\x.ts"], ["C:/x.ts"], ["\\\\server\\share\\x.ts"], ["a/../../x.ts"]])("refuses the Windows-style or escaping path %s", (file) => {
    expect(renameKey(file)).toBeUndefined();
  });

  it("keeps a relative path with Windows separators as a normalized key", () => {
    expect(renameKey("src\\a\\b.ts")).toBe("src/a/b.ts");
  });
});

describe("BranchWatchAnalyzer.renames", { timeout: 60_000 }, () => {
  it("maps a git mv and a 51 % similar move between a commit and the working tree, and between two refs", async () => {
    const root = repository({ "plain.ts": lines("plain", 20), "edited.ts": lines("edited", 20) });
    git(root, "mv", "plain.ts", "moved.ts");
    // About half of the lines change: still above Git's 50 % similarity.
    fs.writeFileSync(path.join(root, "edited.ts"), lines("edited", 12) + lines("other", 8));
    git(root, "mv", "edited.ts", "edited2.ts");
    git(root, "add", "-A");
    const analyzer = new BranchWatchAnalyzer(root);
    const working = await analyzer.renames("main", undefined);
    expect(working.complete).toBe(true);
    expect([...working.moves].sort()).toEqual([["edited.ts", "edited2.ts"], ["plain.ts", "moved.ts"]]);
    git(root, "checkout", "-q", "-b", "feature");
    git(root, "commit", "-m", "move");
    expect([...(await analyzer.renames("main", "HEAD")).moves].sort()).toEqual([["edited.ts", "edited2.ts"], ["plain.ts", "moved.ts"]]);
  });

  it("is incomplete under diff.renameLimit, reading Git's own stderr wording whatever the locale", async () => {
    const root = repository({ "a.ts": lines("a", 20), "b.ts": lines("b", 20) });
    git(root, "config", "diff.renameLimit", "1");
    fs.rmSync(path.join(root, "a.ts"));
    fs.rmSync(path.join(root, "b.ts"));
    fs.writeFileSync(path.join(root, "a2.ts"), lines("a", 15) + lines("x", 5));
    fs.writeFileSync(path.join(root, "b2.ts"), lines("b", 15) + lines("y", 5));
    git(root, "add", "-A");
    vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
    vi.stubEnv("LANGUAGE", "fr");
    const result = await new BranchWatchAnalyzer(root).renames("main", undefined);
    vi.unstubAllEnvs();
    expect(result).toMatchObject({ complete: false, reason: RENAME_LIMIT });
    // The wording the detection reads, as this Git prints it.
    const stderr = spawnSync("git", ["diff", "-M", "--name-status", "main", "--"], { cwd: root, env: { ...process.env, LC_ALL: "C" }, encoding: "utf8" }).stderr;
    expect(stderr).toMatch(/rename detection was skipped due to too many files/);
  });

  it("refuses a ref that starts with `-` without running Git", async () => {
    const root = repository({ "a.ts": "a\n" });
    const result = await new BranchWatchAnalyzer(root).renames("--output=leak.txt", undefined);
    expect(result).toMatchObject({ complete: false, reason: expect.stringContaining('"-"') });
    expect((await new BranchWatchAnalyzer(root).renames("main", "-x")).complete).toBe(false);
    expect(fs.existsSync(path.join(root, "leak.txt"))).toBe(false);
  });

  it("reports a Git failure as incomplete, never throwing", async () => {
    const root = repository({ "a.ts": "a\n" });
    const result = await new BranchWatchAnalyzer(root).renames("no-such-ref", undefined);
    expect(result.complete).toBe(false);
    expect(result.moves.size).toBe(0);
    expect(result.reason).toContain("no-such-ref");
  });

  it("drops absolute and `..` entries and treats truncated or odd -z output as incomplete", async () => {
    const analyzer = new BranchWatchAnalyzer(os.tmpdir());
    const run = vi.spyOn(analyzer as unknown as { run: () => Promise<unknown> }, "run");
    run.mockResolvedValueOnce({ stdout: "R100\0ok.ts\0new.ts\0R100\0a.ts\0../out.ts\0R100\0/abs/x.ts\0y.ts\0", stderr: "" });
    const kept = await analyzer.renames("main", undefined);
    expect(kept).toEqual({ moves: new Map([["ok.ts", "new.ts"]]), complete: true });
    run.mockResolvedValueOnce({ stdout: "R100\0ok.ts\0new.ts", stderr: "" });
    expect(await analyzer.renames("main", undefined)).toMatchObject({ complete: false, reason: "unparseable git output" });
    run.mockResolvedValueOnce({ stdout: "R100\0ok.ts\0", stderr: "" });
    expect((await analyzer.renames("main", undefined)).complete).toBe(false);
  });
});
