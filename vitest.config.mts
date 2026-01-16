import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/benchmarks/**", "tests/vscode-e2e/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      //include: ['src/analyzer/**/*.ts', 'src/webview/**/*.ts', 'src/shared/**/*.ts', 'src/mcp/**/*.ts', 'src/extension/**/*.ts'],
      exclude: [
        /*'**.test.ts',*/ "**/*.d.ts",
        "src/shared/types.ts",
        "src/analyzer/IndexerWorker.ts",
        "src/analyzer/IndexerWorkerHost.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
