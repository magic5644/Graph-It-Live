# Agent benchmark

Does a coding agent answer questions about a codebase better or cheaper when the Graph-It-Live MCP server is available? The agent benchmark (#399) answers this with a small, repeatable measurement:

- 6 questions about this repository at a pinned commit.
- Two arms per client:
  - `native`: shell, read and search tools only;
  - `graph`: the same tools plus the Graph-It-Live MCP server.
- Answers scored against frozen keys.
- Hypotheses and thresholds frozen before the first live run.

The data, answer keys and hypotheses are in [`tests/evals/agent-bench/`](../../tests/evals/agent-bench/README.md). The harness is in `scripts/bench-agent/`. Nothing from the harness ships in the VSIX or the npm package, and no CI workflow runs it.

## Running it

Every route uses a client subscription only. The harness never uses an API key, purchased credits or overage, and never falls back to one. When a client's subscription login cannot be verified, the client is reported as skipped.

| Client | Command | Route |
| --- | --- | --- |
| Claude Code | `npm run build && npm run bench:agent -- --client claude` | automated, `claude -p` on the claude.ai login |
| Codex | `npm run build && npm run bench:agent -- --client codex` | automated, `codex exec --json` on the ChatGPT login |
| GitHub Copilot | `npm run bench:agent -- --print-pack`, then `--score <answers.json>` | manual |

Add `--dry-run` to print the prompts, commands and MCP configs without starting anything. Restrict a run with `--tasks <ids>` and `--arms <ids>`. Each run writes `report.json` and `report.md` to `--out` (default `.reports/agent-bench/`).

The build step is required for the graph arm, which runs `dist/mcpServer.mjs` from the checkout.

### Manual procedure (Copilot)

1. Run `npm run bench:agent -- --print-pack`. It prints the corpus commit, the worktree preparation (remove the agent instruction files), each arm's MCP configuration and the 6 prompts.
2. For each arm, open the prepared worktree with that arm's MCP configuration only. Ask each prompt in a new session, with `copilot -p` or Copilot Chat.
3. Copy each answer, and any usage the client shows, into an answers file shaped like [`answers.example.json`](../../tests/evals/agent-bench/answers.example.json). Set `client: "copilot"`. Leave every counter the client does not show out of the file: the report marks it `unavailable`.
4. Run `npm run bench:agent -- --score <answers.json>`. It writes the same report as the automated clients.

### Expected run count and limits

- One full run per client: 6 tasks × 2 arms = 12 runs, plus at most 6 reruns.
- Reruns happen only for a failed or timed-out cell, or for a task where the two arms got different scores.
- Each run times out after 2 minutes.
- The whole benchmark stops at the first rate-limit, allowance or overage message, and never retries.
- The graph index is built once per run, before the first task. Its cold build time is reported separately and excluded from per-task cost.
- Model time in the first baseline: about 50 s for Claude Code (12 runs) and about 2.5 min for Codex (14 runs).

## Hypotheses (frozen before the first run)

| Class | Tasks | Hypothesis (`graph` vs `native`, same client, model and effort) |
| --- | --- | --- |
| Localization | 2 | Correctness ≥ native, and ≥ 20 % fewer tool calls or provider tokens |
| Callers / impact | 1 | Correctness ≥ native, caller recall ≥ native, same efficiency threshold |
| Multi-file contract | 1 | Correctness ≥ native; extra tokens allowed and reported |
| Known file (negative control) | 2 | Same correctness, at most +1 tool call and +25 % provider tokens |

**Provider tokens** = non-cached input + output, as frozen in `hypotheses.json`. The harness counts cache writes as non-cached input: the provider processes them without a cache hit. So the figure is uncached input + cache writes + output. Cache reads are counted as input and never as a saving.

Each verdict has one of three values:
- **confirmed**: the hypothesis holds.
- **not confirmed**: the difference is within the threshold.
- **refuted**: correctness is lower, or the control exceeds its limit.

With one repetition and 1–2 tasks per class, no verdict is statistically significant.

## First baseline (2026-11-10)

| | Claude Code | Codex |
| --- | --- | --- |
| Client | 2.1.322, claude.ai subscription | codex-cli 0.167.0, ChatGPT subscription |
| Model, effort | `claude-haiku-5-5`, low | `gpt-6-luna`, low |
| Corpus | `069917ca` (v1.24.2) | `069917ca` (v1.24.2) |
| Harness, Graph-It-Live build | `69c056da` plus the #678 changes (`v1.24.2-10-g69c056da-dirty`): run timeout lowered to 2 min, report-only fixes | same |
| Runs | 12, no rerun, no failure, no limit message | 14 (2 reruns on `contract-mcp-worker-ready`), no failure, no limit message |
| Cold index | 1,993 ms | 1,916 ms |

Copilot was not run in this baseline.

### Main finding: the graph arm never called Graph-It-Live

The MCP server was connected in every graph run:
- Claude Code: checked at init; a run without the server is refused.
- Codex: the server is declared `required`.

Yet none of the 13 graph runs (Claude Code 0 of 6, Codex 0 of 7) called a Graph-It-Live tool. Both agents answered every question with `Grep`/`Read` or `rg`/`sed`, exactly like the native arm. The full reports, with every run's tool calls, are attached to #399 and #678. Each report now states this count (*Graph-arm runs that called the Graph-It-Live MCP server*).

So the differences below come from two sources:
- the tool definitions loaded in the graph arm's prompt;
- run-to-run variance.

They do not come from graph answers. **No result here shows a benefit of Graph-It-Live, and none may be claimed in the README or marketplace text.** The finding is useful for routing (#401, #664): making the server available is not enough for these clients to use it.

### Verdicts

| Class | Claude Code | Codex |
| --- | --- | --- |
| Localization | **not confirmed**: same correctness (2/2), +25 % tool calls, 20 % fewer provider tokens (19.6 %, below the threshold) | **not confirmed**: same correctness (2/2), +20 % tool calls, 1 % fewer provider tokens |
| Callers / impact | **confirmed** (no MCP call, not a Graph-It-Live effect): same correctness and recall, 40 % fewer provider tokens | **confirmed** (no MCP call, not a Graph-It-Live effect): same correctness and recall, 70 % fewer provider tokens, from prompt-cache hits |
| Multi-file contract | **confirmed** (no MCP call): same correctness (1.00), provider tokens +42 % | **confirmed** (no MCP call): correctness 1.00 vs 0.88, provider tokens −10 %. The native arm lost one field to answer formatting (below), not to a wrong file |
| Known file (control) | **refuted**: `known-file-toon` +278 % provider tokens (limit +25 %) | **confirmed** (no MCP call): same correctness (1.50/2), within +1 tool call and +25 % provider tokens |

None of the five "confirmed" cells shows a Graph-It-Live gain:
- **Callers/impact** (Claude Code, Codex): the token savings come from runs that never called the server.
- **Multi-file contract** (Claude Code, Codex): the hypothesis only requires correctness ≥ native, and the graph arm never called the server.
- **Known file** (Codex): this negative control only shows that exposing the server cost Codex little.

The known-file control refutes for Claude Code because of the first graph run: it writes the larger prompt prefix to the cache (32,156 cache-write tokens versus 8,399 for native). The difference is most likely the Graph-It-Live tool definitions in the graph prefix (not measured separately). Later graph runs read it back: about 19,000 more cache-read tokens per model request than native, so about 38,000 for a two-turn run. This is the fixed price of exposing the server, paid even when no tool is called.

### Runs (one row per task and arm; means when a cell has two runs)

Claude Code:

| Task | Arm | Runs | Correctness | Tool calls | Provider tokens | Cache read | Latency s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| known-file-toon | native | 1/1 | 1.00 | 1 | 8,552 | 11,921 | 2.9 |
| known-file-toon | graph | 1/1 | 1.00 | 1 | 32,308 | 26,551 | 2.3 |
| known-file-ignored-dirs | native | 1/1 | 1.00 | 1 | 4,908 | 13,688 | 4.0 |
| known-file-ignored-dirs | graph | 1/1 | 1.00 | 1 | 4,863 | 52,077 | 2.4 |
| localization-text-size-limit | native | 1/1 | 1.00 | 1 | 8,874 | 13,718 | 2.5 |
| localization-text-size-limit | graph | 1/1 | 1.00 | 1 | 7,032 | 52,107 | 2.9 |
| localization-tool-path-validation | native | 1/1 | 1.00 | 3 | 12,257 | 29,984 | 7.2 |
| localization-tool-path-validation | graph | 1/1 | 1.00 | 4 | 9,956 | 116,649 | 6.3 |
| callers-ignored-directory | native | 1/1 | 1.00 | 1 | 3,902 | 13,706 | 2.7 |
| callers-ignored-directory | graph | 1/1 | 1.00 | 1 | 2,331 | 52,095 | 3.1 |
| contract-mcp-worker-ready | native | 1/1 | 1.00 | 4 | 9,508 | 34,416 | 6.8 |
| contract-mcp-worker-ready | graph | 1/1 | 1.00 | 5 | 13,546 | 87,409 | 6.6 |

Codex:

| Task | Arm | Runs | Correctness | Tool calls | Provider tokens | Cache read | Latency s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| known-file-toon | native | 1/1 | 0.50 | 3 | 12,776 | 32,000 | 12.2 |
| known-file-toon | graph | 1/1 | 0.50 | 3 | 4,628 | 39,936 | 10.2 |
| known-file-ignored-dirs | native | 1/1 | 1.00 | 1 | 11,684 | 9,344 | 5.9 |
| known-file-ignored-dirs | graph | 1/1 | 1.00 | 1 | 11,650 | 9,472 | 5.6 |
| localization-text-size-limit | native | 1/1 | 1.00 | 2 | 7,752 | 30,848 | 8.8 |
| localization-text-size-limit | graph | 1/1 | 1.00 | 2 | 17,264 | 22,272 | 7.8 |
| localization-tool-path-validation | native | 1/1 | 1.00 | 3 | 29,057 | 30,848 | 15.2 |
| localization-tool-path-validation | graph | 1/1 | 1.00 | 4 | 19,296 | 56,576 | 11.7 |
| callers-ignored-directory | native | 1/1 | 1.00 | 1 | 11,306 | 9,344 | 7.3 |
| callers-ignored-directory | graph | 1/1 | 1.00 | 1 | 3,442 | 17,280 | 8.7 |
| contract-mcp-worker-ready | native | 2/2 | 0.88 | 2.5 | 24,602 | 30,528 | 12.2 |
| contract-mcp-worker-ready | graph | 2/2 | 1.00 | 4 | 22,090 | 79,104 | 16.4 |

Turns are `unavailable` for Codex (`codex exec` emits one `turn.completed` per prompt). Claude Code's turns are in the full reports.

### Partial scores

Every partial score is a Codex answer that names the right thing in a form the exact-match scorer does not accept. Both are counted as given: keys and scorer stay frozen.

- `known-file-toon`, both arms: the `encoding` field is `gpt-tokenizer/encoding/cl100k_base` (the import path) instead of `cl100k_base`.
- `contract-mcp-worker-ready`, native, both runs: the `calledBefore` field is `setupFileWatcher(postMessage)` instead of `setupFileWatcher`.

## Limits

- **One corpus**: this repository at one commit: 1,223 tracked files, 885 of them TypeScript. The results do not generalize to other languages or to large private repositories.
- **Sample size**: one repetition, plus reruns only for disagreements. 1–2 tasks per class. The benchmark detects large differences only; nothing here is statistically significant.
- **Token figures**: provider tokens depend on the prompt cache state, which carries over between consecutive runs. A single run's token saving or excess is within this noise unless it is large and repeated.
- **Cache-write metrics**:
  - Claude Code reports cache writes.
  - Codex emitted no cache-write field in any of the 14 runs, so its cache writes count as 0.
  - Cached input is reported separately and counted as input.
- **No feature parity**: the clients differ in automation and in the metrics they expose, and nothing here implies parity between them. Claude Code's notional cost is computed by the client and is not actual spend.
- **Copilot**: no Copilot run yet; its procedure is manual.

## Not the tool-selection eval

`tests/evals/toolSelection.eval.test.ts` (#165) asks one model, through an API key, which MCP tool it would pick. It measures tool descriptions, not task results, and is not part of this benchmark.
