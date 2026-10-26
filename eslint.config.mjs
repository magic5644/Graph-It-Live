import eslint from "@eslint/js";
import { includeIgnoreFile } from "eslint/config";
import globals from "globals";
import path from "node:path";
import tseslint from "typescript-eslint";

export default [
  // Local, gitignored files (.claude/hooks, .reports, coverage...) are not part of the lint scope.
  includeIgnoreFile(path.join(import.meta.dirname, ".gitignore")),
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      "esbuild.js",
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.benchmark.config.mts",
      "vitest.memory.config.mts",
      ".venv/**",
      "**/*.d.ts",
      "tests/**",
      ".agents/**",
      ".github/**",
      "eslint.config.mjs",
      "scripts/**",
      ".vscode-test/**",
      "**/*.OLD.tsx",
      "**/*.GRAPHD3.tsx",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2020,
      },
      parserOptions: {
        // tsconfig.eslint.json extends tsconfig.json but has no "references",
        // so parserOptions.project can resolve files directly without issues.
        project: ["./tsconfig.eslint.json", "./tsconfig.webview.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      // Mirrors SonarCloud S9382 so new loops are flagged before push; warn only: existing sequential awaits are often intended.
      "no-await-in-loop": "warn",
    },
  },
];
