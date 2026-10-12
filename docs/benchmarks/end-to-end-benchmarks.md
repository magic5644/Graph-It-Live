# End-to-end benchmarks

`scripts/bench-e2e.mjs` runs `dist/graph-it.js` and the VS Code extension on frozen corpora: `self` (this repository extracted with `git archive v1.18.0`), `generated` (a seeded 10,000-module TypeScript workspace, same files on every run), and one medium open-source project per supported language (below). Each sample is one process. A preload loaded through `NODE_OPTIONS` records each process's peak RSS (`process.resourceUsage().maxRSS`, worker threads included) on exit.

| Metric | Measures |
| --- | --- |
| `cli.coldStart` | `graph-it --version` |
| `scan.cold` / `scan.warm` / `scan.afterEdit` | `graph-it scan` with no cache, a valid cache (cache restore and validation), and one file edited |
| `callGraph.cold` / `callGraph.warm` | `graph-it tool query_call_graph` (callers of a hub) without and with `callgraph.db` |
| `mcp.firstResponse` | `graph-it serve` from an empty cache: spawn, handshake and first `find_referencing_files`; peak RSS of the whole session |
| `mcp.findReferencingFiles` / `mcp.queryCallGraph` | Warm requests in the same session, 5 per run |
| `mcp.concurrent5` | 5 identical `query_call_graph` calls sent at once, one burst per run: latency of each call |
| `mcp.concurrent5.queueWait` | Time each call of a burst waited in the server FIFO queue (`queuedAhead` in `McpWorkerHost`). The worker runs one call at a time in arrival order, so a call waits for the latency of the call ahead of it |
| `vscode.activation` | `activate()` of the extension, loaded from source in a fresh VS Code instance (empty profile, empty index cache); RSS is the extension host's after activation |
| `vscode.indexReady` | From activation until the background index reports `complete` (polled through `get_index_status`); background indexing starts when the sidebar view resolves, opened right after activation; extension host RSS at that point |
| `vscode.firstCallGraph` | Then `graph-it-live.showCallGraph` on the hub file until the webview reports the graph rendered (`callGraphReady`); peak RSS of the extension host over the session (worker threads included) |

A second MCP session measures memory stability: `--cycles` index/query cycles (default 20), each a `rebuild_index` followed by `find_referencing_files` and `query_call_graph`. After each cycle, every thread of the server collects garbage (`--expose-gc`) and reports its V8 heap. The report lists the heap of the server main thread and the sum of its worker threads (the MCP worker and its parser workers) after the first and the last cycle, the growth, each group's sampled peak heap (every 50 ms), and the server process peak RSS. Worker threads share the process memory, so RSS has no per-thread split: the per-thread figure is the V8 heap. Cycles are paced 2.1 s apart, under the server limit of 5 `rebuild_index` calls per 10 s.

The VS Code surface runs `tests/vscode-e2e/bench/index.ts` through the E2E harness (`@vscode/test-electron`, the version from `VSCODE_TEST_VERSION`, default `stable`): one VS Code instance per run, opened on the corpus with an empty extensions directory and the built-in TypeScript service disabled (it competes for CPU, and on `generated` it crash-loops on a stack overflow). The steps run one after another: the index status goes through `vscode.lm`, a round trip to the renderer, which a rendering call graph holds up. The extension is activated by `onStartupFinished`; the run fails rather than report 0 ms if it activated before the benchmark could time it. The file graph has no render acknowledgement, so the first graph timed is the call graph.

## Open-source corpora

Each project is pinned to a commit in `scripts/bench-corpora.json`, with its tag, its license, the file edited by `scan.afterEdit` and the hub symbol whose callers are queried. The first run fetches each commit (`git fetch --depth 1`) into a bare repository under `--corpora-dir` and extracts it with `git archive`; later runs reuse it. No third-party code is committed: the workflow caches `--corpora-dir`, keyed on the manifest.

| Corpus | Project | Tag | License | Hub symbol |
| --- | --- | --- | --- | --- |
| `typescript` | [honojs/hono](https://github.com/honojs/hono) | `v4.6.9` | MIT | `useState` (`src/jsx/hooks/index.ts`) |
| `python` | [pallets/flask](https://github.com/pallets/flask) | `3.1.0` | BSD-3-Clause | `render_template` (`src/flask/templating.py`) |
| `rust` | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | `14.1.1` | MIT OR Unlicense | `parse_low_raw` (`crates/core/flags/parse.rs`) |
| `go` | [gin-gonic/gin](https://github.com/gin-gonic/gin) | `v1.10.0` | MIT | `New` (`gin.go`) |
| `java` | [google/gson](https://github.com/google/gson) | `gson-parent-2.11.0` | Apache-2.0 | `fromJson` (`gson/src/main/java/com/google/gson/Gson.java`) |
| `csharp` | [serilog/serilog](https://github.com/serilog/serilog) | `v4.2.0` | Apache-2.0 | `Write` (`src/Serilog/Core/Logger.cs`) |

To change a corpus, update its `tag`, full `commit` and targets together; the new manifest hash invalidates the CI cache.

## Running

Run it with `npm run bench:e2e` (builds the extension, CLI and E2E harness first) or `node scripts/bench-e2e.mjs` after `npm run build && npm run compile:tests`. On Linux without a display, wrap it in `xvfb-run -a`.

Options: `--runs <n>` (default 5), `--corpus <names>` (comma-separated, default every corpus), `--files <n>` (generated size, default 10,000), `--cycles <n>` (memory cycles, default 20), `--no-vscode` (CLI and MCP only, no VS Code instance), `--corpora-dir <dir>` (fetched open-source corpora, default `.reports/bench-e2e/corpora`), `--out <dir>` (default `.reports/bench-e2e/latest`, with `report.json` and `report.md`). The `Benchmark E2E` workflow (`.github/workflows/bench-e2e.yml`) runs it weekly and on demand on Linux. It publishes the report in the job summary and as an artifact. The numbers are absolute, so compare runs from the same machine.

Reference run (macOS arm64, 16 CPUs, Node 22, 5 runs, p50):

| Metric | self (931 files) | generated (10,003 files) |
| --- | --- | --- |
| `cli.coldStart` | 238 ms, 255 MB | 237 ms, 252 MB |
| `scan.cold` | 2,076 ms, 684 MB | 3,737 ms, 603 MB |
| `scan.warm` | 432 ms, 374 MB | 651 ms, 409 MB |
| `scan.afterEdit` | 434 ms, 368 MB | 650 ms, 417 MB |
| `callGraph.cold` | 1,712 ms, 487 MB | 3,303 ms, 723 MB |
| `callGraph.warm` | 428 ms, 378 MB | 1,284 ms, 635 MB |
| `mcp.firstResponse` | 2,438 ms, 991 MB | 4,286 ms, 1,368 MB |
| `mcp.findReferencingFiles` | 2 ms | 105 ms |
| `mcp.queryCallGraph` | 26 ms | 503 ms |
| `mcp.concurrent5` (p50 / p95) | 72 / 121 ms | 1,424 / 2,382 ms |
| `mcp.concurrent5.queueWait` (p50 / p95) | 49 / 97 ms | 951 / 1,899 ms |
| `vscode.activation` | 208 ms, 251 MB | 206 ms, 252 MB |
| `vscode.indexReady` | 2,021 ms, 467 MB | 3,604 ms, 527 MB |
| `vscode.firstCallGraph` (p50 / p95) | 492 / 535 ms, 520 MB | 1,344 ms (1 run), 565 MB; 89,111 / 143,446 ms before the 500-symbol cap of #326 |
| Heap after cycle 1 → 20, server / workers | 106.1 → 106.2 MB / 314.1 → 311.6 MB | 108.0 → 106.6 MB / 258.3 → 258.2 MB |
| Memory session peak RSS | 933 MB | 1,216 MB |
| Cache on disk | reverse index 0.4 MB, call graph 9.9 MB | reverse index 7.0 MB, call graph 24.8 MB |

Open-source corpora, same machine and settings (5 runs, p50; `mcp.concurrent5` p50 / p95):

| Metric | typescript (439 files) | python (249 files) | rust (213 files) | go (120 files) | java (303 files) | csharp (281 files) |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.coldStart` | 253 ms, 256 MB | 248 ms, 255 MB | 249 ms, 254 MB | 247 ms, 252 MB | 246 ms, 251 MB | 244 ms, 251 MB |
| `scan.cold` | 1,741 ms, 589 MB | 975 ms, 477 MB | 1,353 ms, 593 MB | 1,302 ms, 634 MB | 1,797 ms, 596 MB | 1,186 ms, 590 MB |
| `scan.warm` | 428 ms, 370 MB | 404 ms, 383 MB | 406 ms, 382 MB | 402 ms, 386 MB | 415 ms, 378 MB | 418 ms, 374 MB |
| `scan.afterEdit` | 434 ms, 363 MB | 427 ms, 370 MB | 433 ms, 386 MB | 437 ms, 383 MB | 448 ms, 392 MB | 447 ms, 417 MB |
| `callGraph.cold` | 1,332 ms, 448 MB | 521 ms, 391 MB | 770 ms, 433 MB | 647 ms, 429 MB | 1,321 ms, 570 MB | 1,028 ms, 501 MB |
| `callGraph.warm` | 367 ms, 346 MB | 341 ms, 335 MB | 368 ms, 371 MB | 355 ms, 362 MB | 453 ms, 423 MB | 369 ms, 372 MB |
| `mcp.firstResponse` | 2,046 ms, 785 MB | 1,295 ms, 569 MB | 1,671 ms, 746 MB | 1,618 ms, 844 MB | 2,606 ms, 1,028 MB | 1,509 ms, 794 MB |
| `mcp.findReferencingFiles` | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| `mcp.queryCallGraph` | 5 ms | 1 ms | 7 ms | 18 ms | 50 ms | 5 ms |
| `mcp.concurrent5` | 13 / 21 ms | 3 / 4 ms | 20 / 33 ms | 52 / 87 ms | 147 / 246 ms | 14 / 23 ms |
| `mcp.concurrent5.queueWait` | 9 / 17 ms | 2 / 4 ms | 13 / 27 ms | 35 / 70 ms | 99 / 197 ms | 9 / 19 ms |
| `vscode.activation` | 207 ms, 244 MB | 205 ms, 252 MB | 203 ms, 253 MB | 204 ms, 251 MB | 210 ms, 252 MB | 204 ms, 243 MB |
| `vscode.indexReady` | 1,571 ms, 426 MB | 1,499 ms, 396 MB | 1,628 ms, 441 MB | 1,519 ms, 410 MB | 2,039 ms, 493 MB | 1,524 ms, 473 MB |
| `vscode.firstCallGraph` | 148 ms, 458 MB | 104 ms, 443 MB | 130 ms, 508 MB | 213 ms, 445 MB | 1,060 ms, 534 MB | 165 ms, 516 MB |
| Heap after cycle 1 → 20, server / workers | 105.8 → 106 MB / 249.8 → 246.8 MB | 105.2 → 105.6 MB / 223.9 → 222.5 MB | 105.2 → 105.6 MB / 228.3 → 223.6 MB | 105.2 → 105.6 MB / 285 → 333.9 MB | 105.3 → 105.6 MB / 265.6 → 266 MB | 105.6 → 105.6 MB / 241.5 → 243.8 MB |
| Memory session peak RSS | 800 MB | 792 MB | 1,219 MB | 826 MB | 915 MB | 800 MB |
| Cache on disk | reverse index 0.2 MB, call graph 5.7 MB | reverse index 0.0 MB, call graph 3.5 MB | reverse index 0.1 MB, call graph 9.1 MB | reverse index 0.0 MB, call graph 6.1 MB | reverse index 0.0 MB, call graph 24.3 MB | reverse index 0.0 MB, call graph 17.2 MB |
