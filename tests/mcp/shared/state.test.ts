import { beforeEach, describe, expect, it } from "vitest";
import { WorkerState, type WarmupInfo } from "../../../src/mcp/shared/state";

describe("WorkerState", () => {
  let state: WorkerState;

  beforeEach(() => {
    state = new WorkerState();
  });

  describe("initialization", () => {
    it("should initialize with null/false values", () => {
      expect(state.spider).toBeNull();
      expect(state.parser).toBeNull();
      expect(state.resolver).toBeNull();
      expect(state.astWorkerHost).toBeNull();
      expect(state.config).toBeNull();
      expect(state.isReady).toBe(false);
      expect(state.fileWatcher).toBeNull();
    });

    it("should initialize warmupInfo with completed: false", () => {
      expect(state.warmupInfo).toEqual({ completed: false });
    });

    it("should initialize pendingInvalidations as empty map", () => {
      expect(state.pendingInvalidations).toBeInstanceOf(Map);
      expect(state.pendingInvalidations.size).toBe(0);
    });
  });

  describe("getters and setters", () => {
    it("should allow setting and getting spider", () => {
      const mockSpider = { crawl: () => {} } as any;
      state.spider = mockSpider;
      expect(state.spider).toBe(mockSpider);
    });

    it("should allow setting and getting parser", () => {
      const mockParser = { parse: () => {} } as any;
      state.parser = mockParser;
      expect(state.parser).toBe(mockParser);
    });

    it("should allow setting and getting resolver", () => {
      const mockResolver = { resolve: () => {} } as any;
      state.resolver = mockResolver;
      expect(state.resolver).toBe(mockResolver);
    });

    it("should allow setting and getting astWorkerHost", () => {
      const mockHost = { stop: () => {} } as any;
      state.astWorkerHost = mockHost;
      expect(state.astWorkerHost).toBe(mockHost);
    });

    it("should allow setting and getting config", () => {
      const mockConfig = { rootDir: "/test" } as any;
      state.config = mockConfig;
      expect(state.config).toBe(mockConfig);
    });

    it("should allow setting and getting isReady", () => {
      expect(state.isReady).toBe(false);
      state.isReady = true;
      expect(state.isReady).toBe(true);
    });

    it("should allow setting and getting warmupInfo", () => {
      const warmup: WarmupInfo = {
        completed: true,
        durationMs: 1500,
        filesIndexed: 42,
      };
      state.warmupInfo = warmup;
      expect(state.warmupInfo).toEqual(warmup);
    });

    it("should allow setting and getting fileWatcher", () => {
      const mockWatcher = { close: () => Promise.resolve() } as any;
      state.fileWatcher = mockWatcher;
      expect(state.fileWatcher).toBe(mockWatcher);
    });
  });

  describe("requireReady", () => {
    it("should throw if not ready", () => {
      expect(() => state.requireReady()).toThrow(
        /Worker not initialized.*Missing:.*ready flag/
      );
    });

      it("should throw if config missing", () => {
          state.isReady = true;
          state.spider = {} as any;
          state.parser = {} as any;
          state.resolver = {} as any;
          expect(() => state.requireReady()).toThrow(
              /Worker not initialized.*Missing:.*config/
          );
      });

    it("should throw if spider missing", () => {
      state.isReady = true;
      state.parser = {} as any;
      state.resolver = {} as any;
      expect(() => state.requireReady()).toThrow(
        /Worker not initialized.*Missing:.*spider/
      );
    });

    it("should throw if parser missing", () => {
      state.isReady = true;
      state.spider = {} as any;
      state.resolver = {} as any;
      expect(() => state.requireReady()).toThrow(
        /Worker not initialized.*Missing:.*parser/
      );
    });

    it("should throw if resolver missing", () => {
      state.isReady = true;
      state.spider = {} as any;
      state.parser = {} as any;
      expect(() => state.requireReady()).toThrow(
        /Worker not initialized.*Missing:.*resolver/
      );
    });

    it("should not throw when all components ready", () => {
      state.isReady = true;
      state.spider = {} as any;
      state.parser = {} as any;
      state.resolver = {} as any;
        state.config = {
            rootDir: "/test",
            excludeNodeModules: true,
            maxDepth: 50,
        };
      expect(() => state.requireReady()).not.toThrow();
    });
  });

  describe("safe getters", () => {
    it("getSpider should throw if not ready", () => {
      expect(() => state.getSpider()).toThrow(/Worker not initialized/);
    });

    it("getSpider should return spider when ready", () => {
      const mockSpider = { crawl: () => {} } as any;
      state.isReady = true;
      state.spider = mockSpider;
      state.parser = {} as any;
      state.resolver = {} as any;
        state.config = {
            rootDir: "/test",
            excludeNodeModules: true,
            maxDepth: 50,
        };
      expect(state.getSpider()).toBe(mockSpider);
    });

    it("getParser should throw if not ready", () => {
      expect(() => state.getParser()).toThrow(/Worker not initialized/);
    });

    it("getParser should return parser when ready", () => {
      const mockParser = { parse: () => {} } as any;
      state.isReady = true;
      state.spider = {} as any;
      state.parser = mockParser;
      state.resolver = {} as any;
        state.config = {
            rootDir: "/test",
            excludeNodeModules: true,
            maxDepth: 50,
        };
      expect(state.getParser()).toBe(mockParser);
    });

    it("getResolver should throw if not ready", () => {
      expect(() => state.getResolver()).toThrow(/Worker not initialized/);
    });

    it("getResolver should return resolver when ready", () => {
      const mockResolver = { resolve: () => {} } as any;
      state.isReady = true;
      state.spider = {} as any;
      state.parser = {} as any;
      state.resolver = mockResolver;
        state.config = {
            rootDir: "/test",
            excludeNodeModules: true,
            maxDepth: 50,
        };
      expect(state.getResolver()).toBe(mockResolver);
    });

    it("getAstWorkerHost should throw if not set", () => {
      expect(() => state.getAstWorkerHost()).toThrow(
        /AstWorkerHost not initialized/
      );
    });

    it("getAstWorkerHost should return host when set", () => {
      const mockHost = { stop: () => {} } as any;
      state.astWorkerHost = mockHost;
      expect(state.getAstWorkerHost()).toBe(mockHost);
    });

    it("getConfig should throw if not set", () => {
      expect(() => state.getConfig()).toThrow(
        /Config not set.*Call init/
      );
    });

    it("getConfig should return config when set", () => {
      const mockConfig = { rootDir: "/test" } as any;
      state.config = mockConfig;
      expect(state.getConfig()).toBe(mockConfig);
    });
  });

  describe("reset", () => {
    it("should clear all state", () => {
      // Set up state
      state.spider = { crawl: () => {} } as any;
      state.parser = { parse: () => {} } as any;
      state.resolver = { resolve: () => {} } as any;
      state.astWorkerHost = { stop: () => {} } as any;
      state.config = { rootDir: "/test" } as any;
      state.isReady = true;
      state.warmupInfo = { completed: true, durationMs: 1000 };

      // Reset
      state.reset();

      // Verify all cleared
      expect(state.spider).toBeNull();
      expect(state.parser).toBeNull();
      expect(state.resolver).toBeNull();
      expect(state.astWorkerHost).toBeNull();
      expect(state.config).toBeNull();
      expect(state.isReady).toBe(false);
      expect(state.warmupInfo).toEqual({ completed: false });
      expect(state.fileWatcher).toBeNull();
      expect(state.pendingInvalidations.size).toBe(0);
    });

    it("should clear pending invalidations", () => {
      const timeout = setTimeout(() => {}, 1000);
      state.pendingInvalidations.set("file1.ts", timeout);
      state.pendingInvalidations.set("file2.ts", setTimeout(() => {}, 1000));

      expect(state.pendingInvalidations.size).toBe(2);
      state.reset();
      expect(state.pendingInvalidations.size).toBe(0);

      // Cleanup
      clearTimeout(timeout);
    });

    it("should stop astWorkerHost if present", () => {
      let terminated = false;
      state.astWorkerHost = {
        stop: () => {
          terminated = true;
        },
      } as any;

      state.reset();
      expect(terminated).toBe(true);
      expect(state.astWorkerHost).toBeNull();
    });
  });

  describe("getStateSummary", () => {
    it("should return summary with all false/0 when empty", () => {
      const summary = state.getStateSummary();
      expect(summary).toEqual({
        isReady: false,
        hasSpider: false,
        hasParser: false,
        hasResolver: false,
        hasAstWorkerHost: false,
        hasSymbolReverseIndex: false,
        hasConfig: false,
        warmupCompleted: false,
        hasFileWatcher: false,
        pendingInvalidationCount: 0,
      });
    });

    it("should return summary with all true when fully initialized", () => {
      state.spider = {} as any;
      state.parser = {} as any;
      state.resolver = {} as any;
      state.astWorkerHost = { stop: () => {} } as any;
      state.symbolReverseIndex = {} as any;
      state.config = {} as any;
      state.isReady = true;
      state.warmupInfo = { completed: true };
      state.fileWatcher = { close: () => Promise.resolve() } as any;
      state.pendingInvalidations.set("file1.ts", setTimeout(() => {}, 1000));

      const summary = state.getStateSummary();
      expect(summary).toEqual({
        isReady: true,
        hasSpider: true,
        hasParser: true,
        hasResolver: true,
        hasAstWorkerHost: true,
        hasSymbolReverseIndex: true,
        hasConfig: true,
        warmupCompleted: true,
        hasFileWatcher: true,
        pendingInvalidationCount: 1,
      });

      // Cleanup
      state.reset();
    });

    it("should track partial initialization correctly", () => {
      state.spider = {} as any;
      state.config = {} as any;
      state.warmupInfo = { completed: true };

      const summary = state.getStateSummary();
      expect(summary.hasSpider).toBe(true);
      expect(summary.hasConfig).toBe(true);
      expect(summary.warmupCompleted).toBe(true);
      expect(summary.isReady).toBe(false);
      expect(summary.hasParser).toBe(false);
      expect(summary.hasResolver).toBe(false);
    });
  });
});
