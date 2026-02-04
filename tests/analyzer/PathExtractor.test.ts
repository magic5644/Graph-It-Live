import { describe, expect, it } from "vitest";
import { extractFilePath } from "../../src/analyzer/utils/PathExtractor";

describe("PathExtractor", () => {
  describe("extractFilePath", () => {
    it("should return the original path if no colon is found", () => {
      expect(extractFilePath("/src/file.ts")).toBe("/src/file.ts");
        expect(extractFilePath(String.raw`C:\src\file.ts`)).toBe(
            String.raw`C:\src\file.ts`,
        );
      expect(extractFilePath("/Users/test/project/main.py")).toBe(
        "/Users/test/project/main.py",
      );
    });

    it("should handle Windows drive letters (C:, D:, etc.)", () => {
        expect(extractFilePath(String.raw`C:\Users\test\file.ts`)).toBe(
            String.raw`C:\Users\test\file.ts`,
      );
        expect(extractFilePath(String.raw`D:\project\src\module.py`)).toBe(
            String.raw`D:\project\src\module.py`,
      );
        expect(extractFilePath(String.raw`E:\code\lib\utils.rs`)).toBe(
            String.raw`E:\code\lib\utils.rs`,
      );
    });

    it("should extract file path from symbol ID format", () => {
      // TypeScript/JavaScript
      expect(extractFilePath("/src/file.ts:MyClass")).toBe("/src/file.ts");
      expect(extractFilePath("/src/module.tsx:Component")).toBe(
        "/src/module.tsx",
      );
      expect(extractFilePath("/lib/util.js:helper")).toBe("/lib/util.js");
      expect(extractFilePath("/app.jsx:App")).toBe("/app.jsx");
      expect(extractFilePath("/index.mjs:main")).toBe("/index.mjs");
      expect(extractFilePath("/module.cjs:exports")).toBe("/module.cjs");

      // Python
      expect(extractFilePath("/Users/test/script.py:function_name")).toBe(
        "/Users/test/script.py",
      );
      expect(extractFilePath("/lib/module.pyi:TypeAlias")).toBe(
        "/lib/module.pyi",
      );

      // Rust
      expect(extractFilePath("/src/main.rs:main")).toBe("/src/main.rs");
      expect(extractFilePath("/lib.rs:MyStruct")).toBe("/lib.rs");

      // Vue/Svelte
      expect(extractFilePath("/components/Button.vue:ButtonComponent")).toBe(
        "/components/Button.vue",
      );
      expect(extractFilePath("/App.svelte:App")).toBe("/App.svelte");

      // GraphQL
      expect(extractFilePath("/schema.gql:Query")).toBe("/schema.gql");
      expect(extractFilePath("/types.graphql:User")).toBe("/types.graphql");
    });

    it("should handle Windows paths with symbol IDs", () => {
        expect(extractFilePath(String.raw`C:\Users\test\file.ts:MyClass`)).toBe(
            String.raw`C:\Users\test\file.ts`,
      );
        expect(extractFilePath(String.raw`D:\project\module.py:function`)).toBe(
            String.raw`D:\project\module.py`,
      );
    });

    it("should handle complex symbol names with special characters", () => {
      expect(extractFilePath("/src/file.ts:MyClass.method")).toBe(
        "/src/file.ts",
      );
      expect(extractFilePath("/src/file.ts:namespace.MyClass")).toBe(
        "/src/file.ts",
      );
    });

    it("should handle paths with multiple colons in symbol name", () => {
      // Multiple colons: extract only the file path (before first colon after extension)
      expect(extractFilePath("/src/file.ts:Module:MyClass")).toBe(
        "/src/file.ts",
      );
    });

    it("should return path as-is if colon doesn't follow a file extension", () => {
      // These shouldn't be treated as symbol IDs
      expect(extractFilePath("/src:folder/file.ts")).toBe("/src:folder/file.ts");
      expect(extractFilePath("http://example.com/file")).toBe(
        "http://example.com/file",
      );
    });

    it("should handle empty and edge cases", () => {
      expect(extractFilePath("")).toBe("");
      expect(extractFilePath(":")).toBe(":");
      expect(extractFilePath("file.ts:")).toBe("file.ts:");
      expect(extractFilePath(":symbol")).toBe(":symbol");
    });

    it("should be case-insensitive for file extensions", () => {
      expect(extractFilePath("/src/FILE.TS:MyClass")).toBe("/src/FILE.TS");
      expect(extractFilePath("/src/MODULE.PY:func")).toBe("/src/MODULE.PY");
      expect(extractFilePath("/src/MAIN.RS:struct")).toBe("/src/MAIN.RS");
    });

    it("should handle relative paths", () => {
      expect(extractFilePath("./src/file.ts:MyClass")).toBe("./src/file.ts");
      expect(extractFilePath("../lib/module.py:function")).toBe(
        "../lib/module.py",
      );
    });

    it("should handle paths with spaces", () => {
      expect(extractFilePath("/my project/file.ts:MyClass")).toBe(
        "/my project/file.ts",
      );
        expect(extractFilePath(String.raw`C:\My Documents\code.py:func`)).toBe(
            String.raw`C:\My Documents\code.py`,
      );
    });

    it("should handle paths with unicode characters", () => {
      expect(extractFilePath("/项目/文件.ts:类名")).toBe("/项目/文件.ts");
      expect(extractFilePath("/café/módulo.py:función")).toBe(
        "/café/módulo.py",
      );
    });
  });
});
