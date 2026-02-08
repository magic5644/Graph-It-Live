import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { WasmParserFactory } from "@/analyzer/languages/WasmParserFactory";

/**
 * Unit Tests for WasmParserFactory
 *
 * These tests validate the WasmParserFactory implementation with mocked web-tree-sitter.
 * Tests cover initialization, error handling, and parser caching behavior.
 */

// Mock extension path for testing
const mockExtensionPath = path.resolve(process.cwd());

// Mock web-tree-sitter module
vi.mock("web-tree-sitter", () => {
  const mockInit = vi.fn().mockResolvedValue(undefined);
  const mockLanguageLoad = vi.fn().mockResolvedValue({});

  class MockParser {
    static init = mockInit;
    static Language = {
      load: mockLanguageLoad,
    };
    setLanguage = vi.fn();
    parse = vi.fn().mockReturnValue({
      rootNode: {
        toString: vi.fn().mockReturnValue("(module)"),
        descendantsOfType: vi.fn().mockReturnValue([]),
      },
    });
    getLanguage = vi.fn();
    reset = vi.fn();
    delete = vi.fn();
  }

  return {
    Parser: MockParser,
    Language: MockParser.Language,
    default: MockParser,
  };
});

describe("WasmParserFactory Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset factory singleton before each test
    (WasmParserFactory as any).instance = null;
  });

  afterEach(() => {
    // Clean up factory singleton after each test
    const factory = WasmParserFactory.getInstance();
    factory.reset();
    (WasmParserFactory as any).instance = null;
  });

  describe("Singleton Pattern", () => {
    it("should return the same instance on multiple getInstance() calls", () => {
      const factory1 = WasmParserFactory.getInstance();
      const factory2 = WasmParserFactory.getInstance();

      expect(factory1).toBe(factory2);
    });

    it("should create a new instance after reset", () => {
      const factory1 = WasmParserFactory.getInstance();
      const instance1 = (WasmParserFactory as any).instance;

      factory1.reset();
      (WasmParserFactory as any).instance = null;

      const factory2 = WasmParserFactory.getInstance();
      const instance2 = (WasmParserFactory as any).instance;

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("Initialization", () => {
    it("should successfully initialize with valid WASM path (mocked)", async () => {
      const factory = WasmParserFactory.getInstance();
      const wasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

      await expect(factory.init(wasmPath)).resolves.toBeUndefined();
      expect(factory.isInitialized()).toBe(true);
    });

    it("should be idempotent - multiple init() calls should not throw", async () => {
      const factory = WasmParserFactory.getInstance();
      const wasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

      await factory.init(wasmPath);
      await factory.init(wasmPath);
      await factory.init(wasmPath);

      expect(factory.isInitialized()).toBe(true);
    });

    it("should handle concurrent init() calls safely", async () => {
      const factory = WasmParserFactory.getInstance();
      const wasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

      // Create multiple concurrent init calls
      const promises = [factory.init(wasmPath), factory.init(wasmPath), factory.init(wasmPath)];

      await expect(Promise.all(promises)).resolves.toBeDefined();
      expect(factory.isInitialized()).toBe(true);
    });

    it("should not be initialized before init() is called", () => {
      const factory = WasmParserFactory.getInstance();

      expect(factory.isInitialized()).toBe(false);
    });

    it("should reset initialization state on reset()", async () => {
      const factory = WasmParserFactory.getInstance();
      const wasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

      await factory.init(wasmPath);
      expect(factory.isInitialized()).toBe(true);

      factory.reset();
      expect(factory.isInitialized()).toBe(false);
    });
  });

  describe("Parser Creation", () => {
    it("should create parser for Python language (mocked)", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await factory.init(treeSitterWasmPath);
      const parser = await factory.getParser("python", pythonWasmPath);

      expect(parser).toBeDefined();
      expect(parser).not.toBeNull();
    });

    it("should create parser for Rust language (mocked)", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const rustWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-rust.wasm");

      await factory.init(treeSitterWasmPath);
      const parser = await factory.getParser("rust", rustWasmPath);

      expect(parser).toBeDefined();
      expect(parser).not.toBeNull();
    });

    it("should throw error if getParser() called before init()", async () => {
      const factory = WasmParserFactory.getInstance();
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await expect(factory.getParser("python", pythonWasmPath)).rejects.toThrow(
        "WasmParserFactory must be initialized with init() before creating parsers"
      );
    });

    it("should cache parser instances for the same language", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await factory.init(treeSitterWasmPath);

      const parser1 = await factory.getParser("python", pythonWasmPath);
      const parser2 = await factory.getParser("python", pythonWasmPath);

      expect(parser1).toBe(parser2);
    });

    it("should create different parser instances for different languages", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");
      const rustWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-rust.wasm");

      await factory.init(treeSitterWasmPath);

      const pythonParser = await factory.getParser("python", pythonWasmPath);
      const rustParser = await factory.getParser("rust", rustWasmPath);

      expect(pythonParser).not.toBe(rustParser);
    });

    it("should handle concurrent getParser() calls for the same language", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await factory.init(treeSitterWasmPath);

      // Create multiple concurrent getParser calls
      const promises = [
        factory.getParser("python", pythonWasmPath),
        factory.getParser("python", pythonWasmPath),
        factory.getParser("python", pythonWasmPath),
      ];

      const parsers = await Promise.all(promises);

      // All should be the same instance
      expect(parsers[0]).toBe(parsers[1]);
      expect(parsers[1]).toBe(parsers[2]);
    });
  });

  describe("Error Handling", () => {
    it("should throw error if getParser() called before init()", async () => {
      const factory = WasmParserFactory.getInstance();
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await expect(factory.getParser("python", pythonWasmPath)).rejects.toThrow(
        "WasmParserFactory must be initialized with init() before creating parsers"
      );
    });

    it("should handle invalid extension paths gracefully (mocked)", async () => {
      const factory = WasmParserFactory.getInstance();
      const invalidPath = "/nonexistent/path/tree-sitter.wasm";

      // With mocked web-tree-sitter, this won't actually fail,
      // but we can verify the path is passed correctly
      await expect(factory.init(invalidPath)).resolves.toBeUndefined();
    });
  });

  describe("Cache Management", () => {
    it("should clear parser cache on reset()", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await factory.init(treeSitterWasmPath);
      const parser1 = await factory.getParser("python", pythonWasmPath);

      factory.reset();

      // After reset, factory should not be initialized
      expect(factory.isInitialized()).toBe(false);

      // Re-initialize and get parser
      await factory.init(treeSitterWasmPath);
      const parser2 = await factory.getParser("python", pythonWasmPath);

      // Should be able to get a parser (may or may not be the same instance with mocks)
      expect(parser2).toBeDefined();
    });

    it("should maintain separate caches for different languages", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");
      const rustWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-rust.wasm");

      await factory.init(treeSitterWasmPath);

      const pythonParser1 = await factory.getParser("python", pythonWasmPath);
      const rustParser1 = await factory.getParser("rust", rustWasmPath);
      const pythonParser2 = await factory.getParser("python", pythonWasmPath);
      const rustParser2 = await factory.getParser("rust", rustWasmPath);

      // Same language should return same instance
      expect(pythonParser1).toBe(pythonParser2);
      expect(rustParser1).toBe(rustParser2);

      // Different languages should return different instances
      expect(pythonParser1).not.toBe(rustParser1);
    });

    it("should preserve cache across multiple init() calls", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      await factory.init(treeSitterWasmPath);
      const parser1 = await factory.getParser("python", pythonWasmPath);

      // Call init again
      await factory.init(treeSitterWasmPath);
      const parser2 = await factory.getParser("python", pythonWasmPath);

      // Should still be the same cached instance
      expect(parser1).toBe(parser2);
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle typical usage pattern: init -> getParser -> parse", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      // Initialize
      await factory.init(treeSitterWasmPath);

      // Get parser
      const parser = await factory.getParser("python", pythonWasmPath);

      // Parse some code (mocked)
      const tree = parser.parse("import os\nimport sys");

      expect(tree).toBeDefined();
      expect(tree.rootNode).toBeDefined();
    });

    it("should handle multiple languages in sequence", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

      await factory.init(treeSitterWasmPath);

      // Get parsers for different languages
      const pythonParser = await factory.getParser(
        "python",
        path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm")
      );
      const rustParser = await factory.getParser(
        "rust",
        path.join(mockExtensionPath, "dist", "tree-sitter-rust.wasm")
      );

      // Both should be valid
      expect(pythonParser).toBeDefined();
      expect(rustParser).toBeDefined();

      // Parse with both
      const pythonTree = pythonParser.parse("import os");
      const rustTree = rustParser.parse("use std::collections::HashMap;");

      expect(pythonTree.rootNode).toBeDefined();
      expect(rustTree.rootNode).toBeDefined();
    });

    it("should handle reset and re-initialization", async () => {
      const factory = WasmParserFactory.getInstance();
      const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
      const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

      // First initialization
      await factory.init(treeSitterWasmPath);
      const parser1 = await factory.getParser("python", pythonWasmPath);
      expect(parser1).toBeDefined();

      // Reset
      factory.reset();
      expect(factory.isInitialized()).toBe(false);

      // Re-initialize
      await factory.init(treeSitterWasmPath);
      const parser2 = await factory.getParser("python", pythonWasmPath);
      expect(parser2).toBeDefined();
    });
  });
});
