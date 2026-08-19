import { describe, expect, it, vi } from "vitest";
import {
  ServiceContainer,
  type ServiceToken,
} from "../../../src/extension/services/ServiceContainer";

describe("ServiceContainer", () => {
  it("awaits asynchronous service disposal before resolving", async () => {
    const container = new ServiceContainer();
    const token = Symbol("service") as ServiceToken<{ dispose(): Promise<void> }>;
    let resolveDisposal: (() => void) | undefined;
    const dispose = vi.fn(() => new Promise<void>((resolve) => {
      resolveDisposal = resolve;
    }));
    container.register(token, () => ({ dispose }));
    container.get(token);

    let completed = false;
    const disposal = container.dispose().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveDisposal?.();
    await disposal;
    expect(completed).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes singleton services only once across repeated calls", async () => {
    const container = new ServiceContainer();
    const token = Symbol("service") as ServiceToken<{ dispose(): PromiseLike<void> }>;
    const dispose = vi.fn(() => ({ then: (resolve: () => void) => resolve() }));
    container.register(token, () => ({ dispose }));
    container.get(token);

    const first = container.dispose();
    const second = container.dispose();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => container.get(token)).toThrow("Service not registered");
  });
});
