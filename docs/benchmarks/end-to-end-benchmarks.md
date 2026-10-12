# End-to-end benchmarks

`scripts/bench-e2e.mjs` runs `dist/graph-it.js` and the VS Code extension on two frozen corpora: `self` (this repository extracted with `git archive v1.18.0`) and `generated` (a seeded 10,000-module TypeScript workspace, same files on every run). Each sample is one process. A preload loaded through `NODE_OPTIONS` records each process's peak RSS (`process.resourceUsage().maxRSS`, worker threads included) on exit.

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

Run it with `npm run bench:e2e` (builds the extension, CLI and E2E harness first) or `node scripts/bench-e2e.mjs` after `npm run build && npm run compile:tests`. On Linux without a display, wrap it in `xvfb-run -a`.

Options: `--runs <n>` (default 5), `--corpus self,generated`, `--files <n>` (generated size, default 10,000), `--cycles <n>` (memory cycles, default 20), `--no-vscode` (CLI and MCP only, no VS Code instance), `--out <dir>` (default `.reports/bench-e2e/latest`, with `report.json` and `report.md`). The `Benchmark E2E` workflow (`.github/workflows/bench-e2e.yml`) runs it weekly and on demand on Linux. It publishes the report in the job summary and as an artifact. The numbers are absolute, so compare runs from the same machine.

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
