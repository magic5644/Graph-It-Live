import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliProgress, formatDuration } from "@/cli/progress";

const CLEAR = "\r\u001B[K";

describe("CliProgress (#717)", () => {
  let stderr: string[];
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("draws a counter per phase, then a finished line and the total", async () => {
    const progress = new CliProgress(true);
    const value = await progress.phase("Analyzing unused exports", async (tick) => {
      tick(1, 2);
      vi.advanceTimersByTime(1500);
      tick(2, 2);
      return 42;
    });
    progress.finish();

    expect(value).toBe(42);
    expect(stderr).toEqual([
      `${CLEAR}  Analyzing unused exports… 0s`,
      `${CLEAR}  Analyzing unused exports 1/2`,
      `${CLEAR}  Analyzing unused exports 1/2`,
      `${CLEAR}  Analyzing unused exports 2/2`,
      `${CLEAR}  Analyzing unused exports 2/2 (1.5s)\n`,
      "  Done in 1.5s\n",
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("shows the elapsed time when the total is unknown, in phase order", async () => {
    const progress = new CliProgress(true);
    await progress.phase("Laying out diagrams", async () => {
      vi.advanceTimersByTime(12_000);
    });
    await progress.phase("Writing the HTML page", () => undefined);

    expect(stderr).toContain(`${CLEAR}  Laying out diagrams… 12s`);
    const finished = stderr.filter((text) => text.endsWith("\n"));
    expect(finished).toEqual([
      `${CLEAR}  Laying out diagrams (12.0s)\n`,
      `${CLEAR}  Writing the HTML page (0.0s)\n`,
    ]);
  });

  it("writes nothing when disabled (no TTY, tool, serve) and still runs the phase", async () => {
    const progress = new CliProgress(false);
    const ticks: number[] = [];
    await progress.phase("Analyzing architecture", (tick) => {
      tick(1, 1);
      ticks.push(1);
    });
    progress.finish();
    progress.interrupt();
    progress.end();

    expect(ticks).toEqual([1]);
    expect(stderr).toEqual([]);
  });

  it("ends a failing phase with its duration and rethrows", async () => {
    const progress = new CliProgress(true);
    await expect(progress.phase("Reviewing the diff", async () => {
      vi.advanceTimersByTime(3000);
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(stderr.at(-1)).toBe(`${CLEAR}  Reviewing the diff failed after 3.0s\n`);
    vi.advanceTimersByTime(5000);
    expect(stderr.at(-1)).toBe(`${CLEAR}  Reviewing the diff failed after 3.0s\n`);
  });

  it("ends the phase as interrupted on Ctrl-C, once, and stops redrawing", async () => {
    const progress = new CliProgress(true);
    let release: () => void = () => undefined;
    const running = progress.phase("Writing the wiki", () => new Promise<void>((resolve) => { release = resolve; }));
    vi.advanceTimersByTime(2000);
    progress.interrupt();
    vi.advanceTimersByTime(5000);
    release();
    await running;

    expect(stderr.filter((text) => text.endsWith("\n"))).toEqual([`${CLEAR}  Writing the wiki interrupted after 2.0s\n`]);
    expect(stderr.at(-1)).toBe(`${CLEAR}  Writing the wiki interrupted after 2.0s\n`);
  });

  it("draws nothing more after Ctrl-C: no later phase, redraw or final total", async () => {
    const progress = new CliProgress(true);
    progress.interrupt();
    const value = await progress.phase("Finding unreferenced files", (tick) => {
      tick(1, 1);
      return "ran";
    });
    progress.redraw("  Indexing: 9/10 files...");
    progress.finish();

    expect(value).toBe("ran");
    expect(stderr).toEqual([]);
  });

  it("terminates an open indexing line on error or Ctrl-C, and replaces it on a finished line", () => {
    const progress = new CliProgress(false);
    progress.redraw("  Indexing: 3/10 files...");
    progress.end();
    progress.end();
    progress.redraw("  Indexing: 5/10 files...");
    progress.line("  Indexed 10/10 files");
    progress.line("  Warning: x");
    const interrupted = new CliProgress(false);
    interrupted.redraw("  Indexing: 4/10 files...");
    interrupted.interrupt();

    expect(stderr).toEqual([
      `${CLEAR}  Indexing: 3/10 files...`,
      "\n",
      `${CLEAR}  Indexing: 5/10 files...`,
      `${CLEAR}  Indexed 10/10 files\n`,
      "  Warning: x\n",
      `${CLEAR}  Indexing: 4/10 files...`,
      "\n",
    ]);
  });

  it("runs a nested phase without drawing a second line", async () => {
    const progress = new CliProgress(true);
    await progress.phase("Outer", () => progress.phase("Inner", () => undefined));
    expect(stderr.some((text) => text.includes("Inner"))).toBe(false);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0.0s"],
    [3149, "3.1s"],
    [59_949, "59.9s"],
    [59_960, "1m 0s"],
    [60_000, "1m 0s"],
    [92_400, "1m 32s"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
