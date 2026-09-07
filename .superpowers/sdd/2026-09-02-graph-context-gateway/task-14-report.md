# Task 14 report

Commit: `47e7323` (`docs: document graph context gateway and benchmark`)

- Documented the unified graph-context gateway in the ADR, CLI guide, README,
  TOON format guide, and MCP payload-limit reference.
- Verified the public entry points against the implementation:
  `graph-it context`, `graph-it tool graph_context`,
  `graphitlive_graph_context`, and `graph-it-live_graph_context`
  (`#graphContext`).
- Documented the parser-backed modes, repeatable seeds and relations, scope
  globs, directed traversal, cursor constraints, depth/node/token limits, and
  JSON/TOON examples. `maxNodes` is documented as a requested page bound;
  mandatory seeds and path endpoints are preserved, so the actual node count
  can exceed the requested value. Structured bridge arguments use `--args`
  JSON.
- Documented `gpt-tokenizer/encoding/cl100k_base` as a representation-size
  counter, not provider billing usage.
- Kept the Graphify statement narrow and preserved normal release-tag
  versioning. The package version remains `0.0.1`.
- Corrected the graph-context VS Code E2E test to use the Mocha TDD interface
  configured by the suite (`suite`/`test`).

Benchmark evidence:

- Inspected `.reports/context-economy/latest/report.json`, generated on
  2026-09-04 from six workflows over the fixed twelve-file corpus.
- The run measured 8,780 JSON representation tokens and 1,072 TOON tokens with
  `cl100k_base`, a weighted reduction of 87.8%.
- Mean precision@10 was 0.363, mean recall@10 was 0.917, the one path case
  passed, and all six requests respected their configured bounds.
- MCP initialization, MCP tool-call, continuation, and provider billing-token
  metrics were unobserved (`null`). All six Graphify 0.8.36 comparisons were
  `not-supported` under the strict shared bounds, so no parity is claimed.
- The benchmark was not rerun during finalization at the user's request to stop
  long-running work and use bounded checks only.

CLI verification:

- `rtk npm run build:cli` — passed.
- `rtk node dist/graph-it.js context --help` — passed; help covers modes,
  seeds, relations, scope, depth, max nodes, token budget, directed traversal,
  cursor continuation, workspace, and JSON/TOON output.
- `rtk node dist/graph-it.js tool --help` — passed; help shows the tool name
  before `--args` and includes simple and structured `graph_context` examples.
- Direct JSON context invocation, simple TOON bridge passthrough, and directed
  path passthrough through `--args` all exited successfully on the sample
  project. A cursor was correctly rejected after a later standalone invocation
  produced a different index revision.

Validation:

- `rtk npm run lint` — passed.
- `rtk npm run check:types` — passed.
- `rtk npm test -- --run` — failed before tests for the command-line reason
  only:
  the package script already invokes `vitest run`, so the appended `--run`
  duplicated that option and Vitest 4.1.11 raised
  `Expected a single value for option "--run", received [true, true]`.
- `npm test` — passed as the equivalent unit gate: 216 files passed,
  2,536 tests passed, and 13 tests were skipped.
- `npm run test:vscode` — the default invocation failed to start VS Code on
  macOS because this long worktree's IPC socket path exceeded 103 characters
  (`listen EINVAL`); no VS Code test executed in that invocation. This is a
  path-length limitation of the default invocation, not weakened validation.
- `TMPDIR=/tmp rtk npm run test:vscode` — the short-cache workaround used for
  the same compiled VS Code suite; setting the temporary cache/socket root to
  `/tmp` avoided the long worktree path and passed 147 tests in approximately
  five minutes.
- `rtk npm run build` — passed.
- `rtk npm run package` — passed; produced `graph-it-live-0.0.1.vsix`.
- `rtk npm run package:verify` — passed; zero `.map` files were found.
- No validation-gate command was skipped. The two non-passing exact invocations
  and their successful equivalents/workaround are recorded above.
