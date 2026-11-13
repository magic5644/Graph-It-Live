/**
 * Phase lines on stderr for long CLI commands (#717): one redrawn line per phase, a counter when the total is
 * known or the elapsed time otherwise, then a final total. stdout is never written.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

/** Reports `done` of `total` items processed in the current phase. */
export type PhaseTick = (done: number, total: number) => void;

const CLEAR_LINE = "\r\u001B[K";
const REDRAW_MS = 1000;

/** `3.1s` under a minute, `1m 32s` above. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export class CliProgress {
  private readonly startedAt = Date.now();
  /** A `\r`-redrawn line is on stderr without its newline yet. */
  private open = false;
  private current: { label: string; startedAt: number; timer: NodeJS.Timeout } | undefined;
  /** Set by interrupt(): the phases still running after Ctrl-C draw nothing. */
  private interrupted = false;

  /** `enabled`: phase lines and the final total are drawn; the caller passes false off a TTY, in `tool` and `serve`. */
  constructor(readonly enabled: boolean) {}

  /** Redraws the open line in place. */
  redraw(text: string): void {
    if (this.interrupted) return;
    process.stderr.write(`${CLEAR_LINE}${text}`);
    this.open = true;
  }

  /** Writes a finished line, replacing the open one if any. */
  line(text: string): void {
    process.stderr.write(`${this.open ? CLEAR_LINE : ""}${text}\n`);
    this.open = false;
  }

  /** Runs `run` as one phase; disabled, interrupted or inside another phase, it only runs it. */
  async phase<T>(label: string, run: (tick: PhaseTick) => Promise<T> | T): Promise<T> {
    if (!this.enabled || this.interrupted || this.current) return run(() => undefined);
    let counter = "";
    const startedAt = Date.now();
    const draw = (): void => {
      const status = counter || `… ${Math.floor((Date.now() - startedAt) / 1000)}s`;
      this.redraw(`  ${label}${status}`);
    };
    const phase = { label, startedAt, timer: setInterval(draw, REDRAW_MS).unref() };
    this.current = phase;
    draw();
    try {
      const result = await run((done, total) => {
        counter = ` ${done}/${total}`;
        if (this.current === phase) draw();
      });
      this.endPhase(phase, `${counter} (${formatDuration(Date.now() - startedAt)})`);
      return result;
    } catch (error) {
      this.endPhase(phase, ` failed after ${formatDuration(Date.now() - startedAt)}`);
      throw error;
    }
  }

  /** The final line, once the command succeeded. */
  finish(): void {
    if (this.enabled && !this.interrupted) this.line(`  Done in ${formatDuration(Date.now() - this.startedAt)}`);
  }

  /** Ctrl-C: ends the current phase as interrupted, or terminates any open line. */
  interrupt(): void {
    this.interrupted = true;
    if (this.current) this.endPhase(this.current, ` interrupted after ${formatDuration(Date.now() - this.current.startedAt)}`);
    else this.end();
  }

  /** Terminates an open line so the next stderr message starts on its own line. */
  end(): void {
    if (!this.open) return;
    process.stderr.write("\n");
    this.open = false;
  }

  /** No-op once the phase was ended (by interrupt()). */
  private endPhase(phase: NonNullable<CliProgress["current"]>, suffix: string): void {
    clearInterval(phase.timer);
    if (this.current !== phase) return;
    this.current = undefined;
    this.line(`  ${phase.label}${suffix}`);
  }
}
