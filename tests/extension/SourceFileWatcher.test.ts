import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceFileWatcher } from "../../src/extension/services/SourceFileWatcher";
import type { FileChangeScheduler } from "../../src/extension/services/FileChangeScheduler";
import { ARCHITECTURE_RULES_GLOB, RESOLVER_CONFIG_GLOB, WATCH_GLOB } from "../../src/shared/constants";

type Listener = (uri: { fsPath: string }) => void;

const watchers = vi.hoisted(() => [] as Array<{
  glob: string;
  listeners: Record<"create" | "change" | "delete", Listener>;
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: vi.fn((glob: string) => {
      const watcher = { glob, listeners: {} as Record<"create" | "change" | "delete", Listener>, dispose: vi.fn() };
      watchers.push(watcher);
      return {
        onDidCreate: (listener: Listener) => { watcher.listeners.create = listener; },
        onDidChange: (listener: Listener) => { watcher.listeners.change = listener; },
        onDidDelete: (listener: Listener) => { watcher.listeners.delete = listener; },
        dispose: watcher.dispose,
      };
    }),
  },
}));

describe("SourceFileWatcher", () => {
  const enqueue = vi.fn();
  const subscriptions: unknown[] = [];
  let sourceWatcher: SourceFileWatcher;

  beforeEach(() => {
    watchers.length = 0;
    subscriptions.length = 0;
    enqueue.mockClear();
    sourceWatcher = new SourceFileWatcher({
      context: { subscriptions } as never,
      logger: { debug: vi.fn(), error: vi.fn() },
      fileChangeScheduler: { enqueue } as unknown as FileChangeScheduler,
    });
  });

  it("watches source files, architecture rules and resolver configs (#419)", () => {
    expect(watchers.map(watcher => watcher.glob)).toEqual([WATCH_GLOB, ARCHITECTURE_RULES_GLOB, RESOLVER_CONFIG_GLOB]);
    expect(subscriptions).toHaveLength(3);
  });

  it("enqueues create, change and delete events", () => {
    const resolverConfig = watchers[2].listeners;
    resolverConfig.create({ fsPath: "/workspace/tsconfig.json" });
    resolverConfig.change({ fsPath: String.raw`C:\workspace\pkg\package.json` });
    resolverConfig.delete({ fsPath: "/workspace/tsconfig.app.json" });

    expect(enqueue.mock.calls).toEqual([
      ["/workspace/tsconfig.json", "create"],
      [String.raw`C:\workspace\pkg\package.json`, "change"],
      ["/workspace/tsconfig.app.json", "delete"],
    ]);
  });

  it("ignores events inside excluded directories, on both separators", () => {
    const { create, change, delete: remove } = watchers[2].listeners;
    create({ fsPath: "/workspace/node_modules/lib/package.json" });
    change({ fsPath: String.raw`C:\workspace\dist\tsconfig.json` });
    remove({ fsPath: "/workspace/.git/package.json" });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("disposes every watcher", () => {
    sourceWatcher.dispose();
    expect(watchers.every(watcher => watcher.dispose.mock.calls.length === 1)).toBe(true);
  });
});
