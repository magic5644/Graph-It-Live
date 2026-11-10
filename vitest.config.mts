import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [
    {
      // Mirrors esbuild's `with { type: "text" }` import of the inlined logo.
      name: "svg-as-text",
      enforce: "pre",
      load(id) {
        return id.endsWith(".svg") ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};` : null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    // Many suites build a real index in hooks; Windows/macOS CI runners are several times slower than a dev machine.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/vscode-e2e/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts", "scripts/bench-agent/**/*.mjs"],
      //include: ['src/analyzer/**/*.ts', 'src/webview/**/*.ts', 'src/shared/**/*.ts', 'src/mcp/**/*.ts', 'src/extension/**/*.ts'],
      exclude: [
        /*'**.test.ts',*/ "**/*.d.ts",
        "src/shared/types.ts",
        "src/analyzer/IndexerWorker.ts",
        "src/analyzer/IndexerWorkerHost.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
