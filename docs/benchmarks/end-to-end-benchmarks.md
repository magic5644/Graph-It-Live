# End-to-end benchmarks

`scripts/bench-e2e.mjs` runs `dist/graph-it.js` on two frozen corpora: `self` (this repository extracted with `git archive v1.18.0`) and `generated` (a seeded 10,000-module TypeScript workspace, same files on every run). Each sample is one process. A preload loaded through `NODE_OPTIONS` records each process's peak RSS (`process.resourceUsage().maxRSS`, worker threads included) on exit.

| Metric | Measures |
| --- | --- |
| `cli.coldStart` | `graph-it --version` |
| `scan.cold` / `scan.warm` / `scan.afterEdit` | `graph-it scan` with no cache, a valid cache (cache restore and validation), and one file edited |
| `callGraph.cold` / `callGraph.warm` | `graph-it tool query_call_graph` (callers of a hub) without and with `callgraph.db` |
| `mcp.firstResponse` | `graph-it serve` from an empty cache: spawn, handshake and first `find_referencing_files`; peak RSS of the whole session |
| `mcp.findReferencingFiles` / `mcp.queryCallGraph` | Warm requests in the same session, 5 per run |

Run it with `npm run bench:e2e` (builds the CLI first) or `node scripts/bench-e2e.mjs` after `npm run build:cli`.

Options: `--runs <n>` (default 5), `--corpus self,generated`, `--files <n>` (generated size, default 10,000), `--out <dir>` (default `.reports/bench-e2e/latest`, with `report.json` and `report.md`). The `Benchmark E2E` workflow (`.github/workflows/bench-e2e.yml`) runs it weekly and on demand on Linux. It publishes the report in the job summary and as an artifact. The numbers are absolute, so compare runs from the same machine.

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
| Cache on disk | reverse index 0.4 MB, call graph 9.9 MB | reverse index 7.0 MB, call graph 24.8 MB |
