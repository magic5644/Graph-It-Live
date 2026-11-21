import { describe, expect, it } from "vitest";
import { untilCancelled } from "@/extension/services/untilCancelled";

function token() {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: false,
    listeners,
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("untilCancelled", () => {
  it("resolves true once the work settles, with or without a token, and unsubscribes", async () => {
    expect(await untilCancelled(Promise.resolve())).toBe(true);
    const cancel = token();
    expect(await untilCancelled(Promise.resolve(1), cancel)).toBe(true);
    expect(cancel.listeners.size).toBe(0);
  });

  it("resolves false on cancel while the work goes on", async () => {
    const cancel = token();
    let finish = () => {};
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waited = untilCancelled(work, cancel);
    cancel.cancel();
    expect(await waited).toBe(false);
    finish();
    await work;
  });

  it("resolves false at once for a token already cancelled, even when the work fails later", async () => {
    const cancel = token();
    cancel.cancel();
    expect(await untilCancelled(Promise.reject(new Error("walk failed")), cancel)).toBe(false);
  });

  it("rejects when the work fails before a cancel", async () => {
    await expect(untilCancelled(Promise.reject(new Error("walk failed")), token())).rejects.toThrow("walk failed");
    await expect(untilCancelled(Promise.reject("text"), token())).rejects.toThrow("text");
  });
});
