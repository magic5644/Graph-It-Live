# PROJECT SPECIFICATION: Graph-It-Live (VS Code Extension)

## 1. ROLE & CONTEXT
You are a Senior VS Code Extension Architect and TypeScript Expert.
Your task is to build a high-performance VS Code extension named **"Graph-It-Live"**.
This tool visualizes the dependencies of the currently active file in a real-time interactive graph.

**Target Models:** Claude 4.5 Sonnet, GPT-5.1-Codex, Raptor mini, Gemini 3.5 Pro.

---

## 2. TECHNICAL STACK

* **Core Framework:** VS Code Extension API.
* **Language:** TypeScript (Strict Mode).
* **Bundler:** `esbuild`.
* **Visualization Engine:** `React Flow` (rendered inside a VS Code Webview).
* **UI Framework:** React (inside Webview).
* **Communication:** Message Passing (RPC-like).
* **Testing & Dev Loop:** `Vitest` (for isolated logic testing), `vscode-test` (for E2E).

---

## 3. CORE FEATURE: THE CUSTOM ANALYZER ("The Spider")

**CRITICAL ARCHITECTURE RULE (THE DECOUPLING WALL):**
The Analyzer module (`src/analyzer/*`) must be **completely agnostic** of VS Code.
* **FORBIDDEN:** `import * as vscode from 'vscode'` inside the analyzer.
* **ALLOWED:** `import * as fs from 'fs'`, `import * as path from 'path'`.
* **WHY?** This allows us to test the logic instantly using `Vitest` without launching the VS Code Debugger.

### 3.1. Analyzer Specifications
Create a module named `src/analyzer/Spider.ts`.

1.  **Parsing Strategy (Regex-based):**
    * Scan file content for: `import ... from ...`, `require(...)`, `export ... from ...`, `import(...)`.
    * Extract the **module path** only.

2.  **Path Resolution (The Heavy Lifting):**
    * **Input:** `currentFilePath` (absolute), `importPath` (relative or alias).
    * **Logic:**
        * Resolve relative paths (`./`, `../`).
        * Resolve implicit extensions (`.ts`, `.js`, `.tsx`, `/index.ts`).
        * Resolve Aliases: Parse `tsconfig.json` (compilerOptions.paths) to resolve `@/components/...`.
    * **Dependency Injection:** The `Spider` class should accept a configuration object (e.g., `tsConfigPaths`) in its constructor, rather than reading files globally, to facilitate testing.

3.  **Performance:**
    * Use `fs.promises` for non-blocking I/O.
    * Implement a simple in-memory cache: `Map<FilePath, DependencyList>`.

---

## 4. UI/UX SPECIFICATIONS (The Webview)

1.  **Interactive Graph:**
    *   **Nodes:** Represent files. Differentiate extensions by color (TS=Blue, JS=Yellow, Node_modules=Grey).
    *   **Edges:** Animated particles showing flow.
    *   **Layout:** Use `dagre` or `elkjs` to automatically arrange nodes (prevent overlap).
    *   **Controls:** Zoom, Pan, and Fit View controls must be visible and functional.
    *   **Styling:** Use VS Code native colors and Codicons for buttons.

2.  **Integration (Webview View):**
    *   **Type:** Implement `vscode.WebviewViewProvider` to allow the graph to be displayed in the Sidebar or Panel (not just an editor tab).
    *   **Sync Logic:**
        *   **Extension -> Webview:** Sends `{ dependencies: [...] }` when the user switches tabs or edits a file.
        *   **Webview -> Extension:** Sends `{ command: 'openFile', path: '...' }` when a node is clicked.

---

## 5. CI/CD & DEVOPS (GitHub Actions)

Create `.github/workflows/main.yml`:
1.  **Triggers:** Push to main, PRs.
2.  **Job: Build & Test:**
    * `npm ci`
    * `npm run lint` (ESLint)
    * `npm run test` (Vitest - Unit tests for Spider)
    * `npm run test:e2e` (VS Code Integration tests - optional for MVP)
3.  **Job: Release:**
    * If tag `v*` is pushed:
    * Run `vsce package`.
    * Create GitHub Release.
    * Upload `.vsix` asset.

---

## 6. IMPLEMENTATION PLAN (Step-by-Step)

*Generate code following this exact sequence to ensure isolation:*

**STEP 1: Project Skeleton**
* Initialize `package.json` (deps: `vitest`, `typescript`, `esbuild`, `react`, `react-flow-renderer`).
* Setup `tsconfig.json`.
* Create the folder structure: `src/analyzer`, `src/webview`, `src/extension`, `tests/fixtures`.

**STEP 2: The Isolated Analyzer (TDD First)**
* **Action A:** Create `tests/fixtures` folder with dummy files (`main.ts`, `utils.ts`, `tsconfig.json`).
* **Action B:** Create `tests/Spider.test.ts` using Vitest. Write a failing test that expects `main.ts` to depend on `utils.ts`.
* **Action C:** Implement `src/analyzer/Spider.ts` (Node.js only) to pass the test.
* **Action D:** Add Alias resolution logic and test it against the fixture `tsconfig.json`.

**STEP 3: The Webview UI**
* Setup React & React Flow in `src/webview`.
* Mock data initially to ensure the graph renders correctly.

**STEP 4: VS Code Integration (The Bridge)**
*   Create `src/extension/GraphProvider.ts` implementing `vscode.WebviewViewProvider`.
*   Update `package.json` to contribute a View Container and View.
*   Initialize the `Spider` instance within the provider or extension main.
*   Hook into `vscode.window.onDidChangeActiveTextEditor` to trigger updates on the provider.
*   Pass real data from `Spider` to the Webview.

**STEP 5: Packaging**
* Setup `esbuild` scripts to bundle Extension (Node) and Webview (Browser) separately.
* Generate the GitHub Actions workflow.

---

## 7. CODING STANDARDS

* **Isolation:** `src/analyzer` strictly explicitly forbids `vscode` module.
* **Error Handling:** Graceful degradation. If parsing fails, return empty list, do not crash.
* **Async:** All I/O must be async/await.
