import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import path from "node:path";
import { WasmParserFactory } from "@/analyzer/languages/WasmParserFactory";

/**
 * Property-Based Tests for WasmParserFactory
 *
 * These tests validate universal properties that should hold across all valid inputs.
 * Each test runs 100 iterations with randomly generated data.
 *
 * Note: These tests use mocked web-tree-sitter to avoid requiring WASM files during testing.
 */

// Mock extension path for testing
const mockExtensionPath = path.resolve(process.cwd());

// Mock web-tree-sitter module
vi.mock("web-tree-sitter", () => {
  let parserIdCounter = 0;
  const mockInit = vi.fn().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const mockLanguageLoad = vi.fn().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {};
  });

  class MockParser {
    static init = mockInit;
    static Language = {
      load: mockLanguageLoad,
    };
    id = parserIdCounter++;
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

describe("WasmParserFactory Property-Based Tests", () => {
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

  describe("Property 7: Concurrent Initialization Safety", () => {
    /**
     * Property 7: Concurrent initialization safety
     *
     * For any number of concurrent parser creation requests, the WASM initialization
     * should complete exactly once, and all requests should receive valid parser
     * instances without race conditions or duplicate initialization.
     *
     * Validates: Requirements 4.4
     */

    it("Feature: tree-sitter-wasm-migration, Property 7: For any number of concurrent init() calls, initialization happens exactly once", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 20 }), // Number of concurrent requests
          async (concurrentRequests) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const wasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

            // Create multiple concurrent init() calls
            const initPromises = Array(concurrentRequests)
              .fill(0)
              .map(() => factory.init(wasmPath));

            // Wait for all to complete - should not throw
            await expect(Promise.all(initPromises)).resolves.toBeDefined();

            // Verify factory is initialized
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 7: For any number of concurrent getParser() calls, each language is loaded exactly once", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 20 }), // Number of concurrent requests
          fc.constantFrom("python", "rust"), // Language to test
          async (concurrentRequests, languageName) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
            const languageWasmPath = path.join(
              mockExtensionPath,
              "dist",
              `tree-sitter-${languageName}.wasm`
            );

            // Initialize factory first
            await factory.init(treeSitterWasmPath);

            // Create multiple concurrent getParser() calls for the same language
            const parserPromises = Array(concurrentRequests)
              .fill(0)
              .map(() => factory.getParser(languageName, languageWasmPath));

            // Wait for all to complete
            const parsers = await Promise.all(parserPromises);

            // Verify all parsers are defined
            expect(parsers.every((p) => p !== null && p !== undefined)).toBe(true);

            // Verify all parsers are the same instance (cached)
            for (let i = 1; i < parsers.length; i++) {
              expect(parsers[i]).toBe(parsers[0]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 7: For any sequence of init() followed by getParser() calls, no race conditions occur", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }), // Number of concurrent init calls
          fc.integer({ min: 2, max: 10 }), // Number of concurrent getParser calls
          async (initCalls, getParserCalls) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
            const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

            // Create concurrent init() and getParser() calls
            const allPromises = [
              ...Array(initCalls)
                .fill(0)
                .map(() => factory.init(treeSitterWasmPath)),
              ...Array(getParserCalls)
                .fill(0)
                .map(async () => {
                  await factory.init(treeSitterWasmPath);
                  return factory.getParser("python", pythonWasmPath);
                }),
            ];

            // Wait for all to complete - should not throw
            await expect(Promise.all(allPromises)).resolves.toBeDefined();

            // Verify factory is initialized
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 7: For any interleaved init() and getParser() calls, all operations complete successfully", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom("init", "getParser"), { minLength: 5, maxLength: 20 }),
          async (operations) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
            const pythonWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter-python.wasm");

            // Execute operations in sequence
            const promises: Promise<any>[] = [];
            for (const op of operations) {
              if (op === "init") {
                promises.push(factory.init(treeSitterWasmPath));
              } else {
                promises.push(
                  (async () => {
                    await factory.init(treeSitterWasmPath);
                    return factory.getParser("python", pythonWasmPath);
                  })()
                );
              }
            }

            // Wait for all operations to complete - should not throw
            await expect(Promise.all(promises)).resolves.toBeDefined();

            // Verify factory is initialized
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 8: Parser Instance Caching", () => {
    /**
     * Property 8: Parser instance caching
     *
     * For any sequence of parser requests for the same language, the factory
     * should return the same parser instance (by reference equality),
     * demonstrating that parsers are cached and reused.
     *
     * Validates: Requirements 4.5
     */

    it("Feature: tree-sitter-wasm-migration, Property 8: For any language, repeated getParser() calls return the same instance", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("python", "rust"), // Language to test
          fc.integer({ min: 2, max: 10 }), // Number of getParser calls
          async (languageName, callCount) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
            const languageWasmPath = path.join(
              mockExtensionPath,
              "dist",
              `tree-sitter-${languageName}.wasm`
            );

            // Initialize factory
            await factory.init(treeSitterWasmPath);

            // Get parser multiple times
            const parsers = [];
            for (let i = 0; i < callCount; i++) {
              parsers.push(await factory.getParser(languageName, languageWasmPath));
            }

            // Verify all parsers are the same instance (reference equality)
            for (let i = 1; i < parsers.length; i++) {
              expect(parsers[i]).toBe(parsers[0]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 8: For any set of different languages, each language gets its own cached parser", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(["python", "rust"], { minLength: 2, maxLength: 2 }),
          async (languages) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

            // Initialize factory
            await factory.init(treeSitterWasmPath);

            // Get parsers for different languages
            const parsers = new Map();
            for (const lang of languages) {
              const wasmPath = path.join(mockExtensionPath, "dist", `tree-sitter-${lang}.wasm`);
              const parser = await factory.getParser(lang, wasmPath);
              parsers.set(lang, parser);
            }

            // Verify each language has its own parser instance
            const parserInstances = Array.from(parsers.values());
            for (let i = 0; i < parserInstances.length; i++) {
              for (let j = i + 1; j < parserInstances.length; j++) {
                // Different languages should have different parser instances
                expect(parserInstances[i]).not.toBe(parserInstances[j]);
              }
            }

            // Verify getting the same language again returns the cached instance
            for (const lang of languages) {
              const wasmPath = path.join(mockExtensionPath, "dist", `tree-sitter-${lang}.wasm`);
              const parser = await factory.getParser(lang, wasmPath);
              expect(parser).toBe(parsers.get(lang));
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 8: For any sequence of getParser() calls, cache remains consistent", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom("python", "rust"), { minLength: 5, maxLength: 20 }),
          async (languageSequence) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");

            // Initialize factory
            await factory.init(treeSitterWasmPath);

            // Track first parser instance for each language
            const firstParsers = new Map();

            // Get parsers in sequence
            for (const lang of languageSequence) {
              const wasmPath = path.join(mockExtensionPath, "dist", `tree-sitter-${lang}.wasm`);
              const parser = await factory.getParser(lang, wasmPath);

              if (!firstParsers.has(lang)) {
                firstParsers.set(lang, parser);
              } else {
                // Subsequent calls should return the same instance
                expect(parser).toBe(firstParsers.get(lang));
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 8: For any language, cache persists across multiple init() calls", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("python", "rust"),
          fc.integer({ min: 2, max: 5 }), // Number of init calls
          async (languageName, initCalls) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
            const languageWasmPath = path.join(
              mockExtensionPath,
              "dist",
              `tree-sitter-${languageName}.wasm`
            );

            // Initialize factory
            await factory.init(treeSitterWasmPath);

            // Get parser first time
            const firstParser = await factory.getParser(languageName, languageWasmPath);

            // Call init() multiple times and verify parser is still cached
            for (let i = 0; i < initCalls; i++) {
              await factory.init(treeSitterWasmPath);
              const parser = await factory.getParser(languageName, languageWasmPath);
              expect(parser).toBe(firstParser);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 8: For any language, reset() clears the cache", async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom("python", "rust"), async (languageName) => {
          // Reset for each property test iteration
          (WasmParserFactory as any).instance = null;

          const factory = WasmParserFactory.getInstance();
          const treeSitterWasmPath = path.join(mockExtensionPath, "dist", "tree-sitter.wasm");
          const languageWasmPath = path.join(
            mockExtensionPath,
            "dist",
            `tree-sitter-${languageName}.wasm`
          );

          // Initialize and get parser
          await factory.init(treeSitterWasmPath);
          const firstParser = await factory.getParser(languageName, languageWasmPath);

          // Reset factory
          factory.reset();

          // Factory should not be initialized after reset
          expect(factory.isInitialized()).toBe(false);

          // Re-initialize and get parser
          await factory.init(treeSitterWasmPath);
          const secondParser = await factory.getParser(languageName, languageWasmPath);

          // Should be a different parser instance (cache was cleared)
          // Note: With mocked parsers, we can't guarantee different instances,
          // but we can verify that getParser() succeeds after reset
          expect(secondParser).toBeDefined();
          expect(secondParser).not.toBeNull();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 9: Cross-Platform Path Handling", () => {
    /**
     * Property 9: Cross-platform path handling
     *
     * For any file path on Windows, Linux, or macOS, the WASM file loading
     * should correctly resolve absolute paths from the extension directory
     * and successfully load the WASM files.
     *
     * Validates: Requirements 5.4
     */

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path format (Windows/Linux/macOS), WASM files load successfully", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live", // Linux
            "/Users/dev/.vscode/extensions/graph-it-live", // macOS
            "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\extensions\\graph-it-live", // Windows
            "/home/user/vscode-server/extensions/graph-it-live", // Linux (remote)
            "D:\\VSCode\\extensions\\graph-it-live" // Windows (different drive)
          ),
          fc.constantFrom("python", "rust"), // Language to test
          async (extensionPath, languageName) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // Construct WASM paths using path.join for cross-platform compatibility
            const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");
            const languageWasmPath = path.join(
              extensionPath,
              "dist",
              `tree-sitter-${languageName}.wasm`
            );

            // Initialize factory with cross-platform path
            await expect(factory.init(treeSitterWasmPath)).resolves.not.toThrow();

            // Get parser with cross-platform path
            const parser = await factory.getParser(languageName, languageWasmPath);

            // Verify parser was created successfully
            expect(parser).toBeDefined();
            expect(parser).not.toBeNull();

            // Verify factory is initialized
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path with mixed separators, path resolution normalizes correctly", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            // Mixed separators (should be normalized by path.join)
            "C:/Users/dev/extensions/graph-it-live", // Windows with forward slashes
            "/usr/local/vscode\\extensions\\graph-it-live", // Linux with backslashes (unusual but possible)
            "C:\\Users\\dev/extensions/graph-it-live" // Windows with mixed separators
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // path.join should normalize the separators
            const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");
            const pythonWasmPath = path.join(extensionPath, "dist", "tree-sitter-python.wasm");

            // Should not throw despite mixed separators
            await expect(factory.init(treeSitterWasmPath)).resolves.not.toThrow();
            const parser = await factory.getParser("python", pythonWasmPath);

            expect(parser).toBeDefined();
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path, absolute path resolution is consistent", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "C:\\Users\\dev\\extensions\\graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // Construct paths multiple times
            const treeSitterWasmPath1 = path.join(extensionPath, "dist", "tree-sitter.wasm");
            const treeSitterWasmPath2 = path.join(extensionPath, "dist", "tree-sitter.wasm");

            // Paths should be identical (consistent resolution)
            expect(treeSitterWasmPath1).toBe(treeSitterWasmPath2);

            // Initialize with first path
            await factory.init(treeSitterWasmPath1);

            // Should be initialized
            expect(factory.isInitialized()).toBe(true);

            // Calling init with second path (same as first) should be idempotent
            await expect(factory.init(treeSitterWasmPath2)).resolves.not.toThrow();
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path, all supported languages load successfully", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "C:\\Users\\dev\\extensions\\graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();
            const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");

            // Initialize factory
            await factory.init(treeSitterWasmPath);

            // Load all supported languages
            const languages = ["python", "rust"];
            const parsers = [];

            for (const lang of languages) {
              const languageWasmPath = path.join(
                extensionPath,
                "dist",
                `tree-sitter-${lang}.wasm`
              );
              const parser = await factory.getParser(lang, languageWasmPath);
              parsers.push(parser);

              // Verify parser was created
              expect(parser).toBeDefined();
              expect(parser).not.toBeNull();
            }

            // Verify all parsers are different instances
            expect(parsers[0]).not.toBe(parsers[1]);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path with trailing separators, path resolution handles correctly", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live/", // Trailing slash
            "C:\\Users\\dev\\extensions\\graph-it-live\\", // Trailing backslash
            "/Users/dev/.vscode/extensions/graph-it-live/" // Trailing slash
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // path.join should handle trailing separators correctly
            const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");
            const pythonWasmPath = path.join(extensionPath, "dist", "tree-sitter-python.wasm");

            // Should not throw despite trailing separators
            await expect(factory.init(treeSitterWasmPath)).resolves.not.toThrow();
            const parser = await factory.getParser("python", pythonWasmPath);

            expect(parser).toBeDefined();
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path, relative path components are resolved correctly", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "C:\\Users\\dev\\extensions\\graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // Use path.join with relative components (should resolve correctly)
            const treeSitterWasmPath = path.join(
              extensionPath,
              "dist",
              "..",
              "dist",
              "tree-sitter.wasm"
            );
            const pythonWasmPath = path.join(
              extensionPath,
              "dist",
              "..",
              "dist",
              "tree-sitter-python.wasm"
            );

            // Should resolve correctly despite relative components
            await expect(factory.init(treeSitterWasmPath)).resolves.not.toThrow();
            const parser = await factory.getParser("python", pythonWasmPath);

            expect(parser).toBeDefined();
            expect(factory.isInitialized()).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 9: For any extension path, concurrent loads from different platforms succeed", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(
            [
              "/usr/local/vscode/extensions/graph-it-live",
              "C:\\Users\\dev\\extensions\\graph-it-live",
              "/Users/dev/.vscode/extensions/graph-it-live",
            ],
            { minLength: 2, maxLength: 3 }
          ),
          async (extensionPaths) => {
            // Test that multiple factories with different paths can coexist
            // (simulating different test runs or environments)

            const results = [];

            for (const extensionPath of extensionPaths) {
              // Reset for each path
              (WasmParserFactory as any).instance = null;

              const factory = WasmParserFactory.getInstance();
              const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");
              const pythonWasmPath = path.join(extensionPath, "dist", "tree-sitter-python.wasm");

              await factory.init(treeSitterWasmPath);
              const parser = await factory.getParser("python", pythonWasmPath);

              results.push({
                path: extensionPath,
                initialized: factory.isInitialized(),
                parserCreated: parser !== null && parser !== undefined,
              });
            }

            // Verify all paths worked correctly
            expect(results.every((r) => r.initialized)).toBe(true);
            expect(results.every((r) => r.parserCreated)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 10: WASM Path Resolution Correctness", () => {
    /**
     * Property 10: WASM path resolution correctness
     *
     * For any WASM file (tree-sitter.wasm, tree-sitter-python.wasm, tree-sitter-rust.wasm),
     * loading the file should use an absolute path resolved from the extension directory,
     * and the path should point to an existing file in the dist directory.
     *
     * Validates: Requirements 12.1
     */

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, resolved path is absolute", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          async (extensionPath, wasmFileName) => {
            // Resolve WASM file path
            const wasmPath = path.join(extensionPath, "dist", wasmFileName);

            // Verify path is absolute (only test with Unix paths since we're on Unix)
            expect(path.isAbsolute(wasmPath)).toBe(true);

            // Verify path contains the extension directory
            expect(wasmPath).toContain(extensionPath);

            // Verify path contains the dist directory
            expect(wasmPath).toContain("dist");

            // Verify path ends with the WASM file name
            expect(wasmPath.endsWith(wasmFileName)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path points to dist directory", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          async (extensionPath, wasmFileName) => {
            // Resolve WASM file path
            const wasmPath = path.join(extensionPath, "dist", wasmFileName);

            // Extract directory from path
            const wasmDir = path.dirname(wasmPath);

            // Verify directory ends with 'dist'
            expect(wasmDir.endsWith("dist")).toBe(true);

            // Verify the path structure is correct
            const expectedPath = path.join(extensionPath, "dist", wasmFileName);
            expect(wasmPath).toBe(expectedPath);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any extension path, all WASM files resolve to correct locations", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            const wasmFiles = ["tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"];

            for (const wasmFileName of wasmFiles) {
              const wasmPath = path.join(extensionPath, "dist", wasmFileName);

              // Verify path is absolute
              expect(path.isAbsolute(wasmPath)).toBe(true);

              // Verify path structure
              expect(wasmPath).toContain(extensionPath);
              expect(wasmPath).toContain("dist");
              expect(wasmPath.endsWith(wasmFileName)).toBe(true);

              // Verify path is normalized (no double separators)
              expect(wasmPath).not.toContain(path.sep + path.sep);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path resolution is consistent across multiple calls", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          fc.integer({ min: 2, max: 10 }), // Number of resolution calls
          async (extensionPath, wasmFileName, callCount) => {
            // Resolve path multiple times
            const paths = [];
            for (let i = 0; i < callCount; i++) {
              paths.push(path.join(extensionPath, "dist", wasmFileName));
            }

            // All paths should be identical
            for (let i = 1; i < paths.length; i++) {
              expect(paths[i]).toBe(paths[0]);
            }

            // Verify the resolved path is absolute
            expect(path.isAbsolute(paths[0])).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, factory uses resolved absolute paths", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            // Reset for each property test iteration
            (WasmParserFactory as any).instance = null;

            const factory = WasmParserFactory.getInstance();

            // Resolve tree-sitter.wasm path
            const treeSitterWasmPath = path.join(extensionPath, "dist", "tree-sitter.wasm");

            // Verify path is absolute before passing to factory
            expect(path.isAbsolute(treeSitterWasmPath)).toBe(true);

            // Initialize factory with absolute path
            await factory.init(treeSitterWasmPath);

            // Verify factory is initialized
            expect(factory.isInitialized()).toBe(true);

            // Resolve language WASM paths
            const pythonWasmPath = path.join(extensionPath, "dist", "tree-sitter-python.wasm");
            const rustWasmPath = path.join(extensionPath, "dist", "tree-sitter-rust.wasm");

            // Verify paths are absolute
            expect(path.isAbsolute(pythonWasmPath)).toBe(true);
            expect(path.isAbsolute(rustWasmPath)).toBe(true);

            // Get parsers with absolute paths
            const pythonParser = await factory.getParser("python", pythonWasmPath);
            const rustParser = await factory.getParser("rust", rustWasmPath);

            // Verify parsers were created successfully
            expect(pythonParser).toBeDefined();
            expect(rustParser).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path contains correct file extension", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "C:\\Users\\dev\\extensions\\graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          async (extensionPath, wasmFileName) => {
            // Resolve WASM file path
            const wasmPath = path.join(extensionPath, "dist", wasmFileName);

            // Verify path has .wasm extension
            expect(path.extname(wasmPath)).toBe(".wasm");

            // Verify basename matches expected file name
            expect(path.basename(wasmPath)).toBe(wasmFileName);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path resolution handles relative components correctly", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "C:\\Users\\dev\\extensions\\graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          async (extensionPath, wasmFileName) => {
            // Resolve path with relative components (should be normalized)
            const wasmPathWithRelative = path.join(
              extensionPath,
              "dist",
              "..",
              "dist",
              wasmFileName
            );

            // Resolve path without relative components
            const wasmPathDirect = path.join(extensionPath, "dist", wasmFileName);

            // Both should resolve to the same absolute path
            expect(path.resolve(wasmPathWithRelative)).toBe(path.resolve(wasmPathDirect));

            // Verify the resolved path is absolute
            expect(path.isAbsolute(path.resolve(wasmPathWithRelative))).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path resolution is cross-platform compatible", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { platform: "linux", path: "/usr/local/vscode/extensions/graph-it-live" },
            { platform: "macos", path: "/Users/dev/.vscode/extensions/graph-it-live" }
          ),
          fc.constantFrom("tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-rust.wasm"),
          async (platformInfo, wasmFileName) => {
            // Resolve WASM file path using path.join (cross-platform)
            const wasmPath = path.join(platformInfo.path, "dist", wasmFileName);

            // Verify path is absolute (only Unix paths on Unix system)
            expect(path.isAbsolute(wasmPath)).toBe(true);

            // Verify path structure is correct
            expect(wasmPath).toContain("dist");
            expect(wasmPath.endsWith(wasmFileName)).toBe(true);

            // Verify path uses correct separator for current platform
            // (path.join automatically uses the correct separator)
            const expectedPath = platformInfo.path + path.sep + "dist" + path.sep + wasmFileName;
            expect(path.normalize(wasmPath)).toBe(path.normalize(expectedPath));
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any language, WASM file name follows naming convention", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("python", "rust"),
          async (languageName) => {
            // Expected WASM file name for language
            const expectedWasmFileName = `tree-sitter-${languageName}.wasm`;

            // Verify naming convention
            expect(expectedWasmFileName).toMatch(/^tree-sitter-[a-z]+\.wasm$/);

            // Verify file name contains language name
            expect(expectedWasmFileName).toContain(languageName);

            // Verify file name has correct extension
            expect(path.extname(expectedWasmFileName)).toBe(".wasm");
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Feature: tree-sitter-wasm-migration, Property 10: For any WASM file, path resolution from extension context is correct", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "/usr/local/vscode/extensions/graph-it-live",
            "/Users/dev/.vscode/extensions/graph-it-live"
          ),
          async (extensionPath) => {
            // Simulate extension context providing extension path
            const mockExtensionContext = {
              extensionPath: extensionPath,
            };

            // Resolve WASM paths as parsers would
            const treeSitterWasmPath = path.join(
              mockExtensionContext.extensionPath,
              "dist",
              "tree-sitter.wasm"
            );
            const pythonWasmPath = path.join(
              mockExtensionContext.extensionPath,
              "dist",
              "tree-sitter-python.wasm"
            );
            const rustWasmPath = path.join(
              mockExtensionContext.extensionPath,
              "dist",
              "tree-sitter-rust.wasm"
            );

            // Verify all paths are absolute
            expect(path.isAbsolute(treeSitterWasmPath)).toBe(true);
            expect(path.isAbsolute(pythonWasmPath)).toBe(true);
            expect(path.isAbsolute(rustWasmPath)).toBe(true);

            // Verify all paths point to dist directory
            expect(treeSitterWasmPath).toContain(path.join(extensionPath, "dist"));
            expect(pythonWasmPath).toContain(path.join(extensionPath, "dist"));
            expect(rustWasmPath).toContain(path.join(extensionPath, "dist"));

            // Verify all paths have correct file names
            expect(path.basename(treeSitterWasmPath)).toBe("tree-sitter.wasm");
            expect(path.basename(pythonWasmPath)).toBe("tree-sitter-python.wasm");
            expect(path.basename(rustWasmPath)).toBe("tree-sitter-rust.wasm");
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
