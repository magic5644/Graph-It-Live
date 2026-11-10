# Agent benchmark data (#399)

Data of the agent benchmark: does an agent answer code questions better or cheaper with the Graph-It-Live MCP server (`graph` arm) than with shell, read and search tools only (`native` arm)?

| File | Content |
| --- | --- |
| `hypotheses.json` | Pinned corpus commit and the *Evidence of value* hypotheses and thresholds, frozen before the tasks. Not tuned after results. |
| `tasks.json` | The 6 tasks (2 known-file controls, 2 localization, 1 callers/impact, 1 multi-file contract), their fixed JSON answer shapes and hand-reviewed answer keys. |
| `answers.example.json` | Answers-file format for `--score`, and the recorded fixture of the unit tests. Invented figures. |

The harness lives in `scripts/bench-agent/`. Manual modes, which start no agent client and call no model (git object reads only):

```sh
npm run bench:agent -- --print-pack [--tasks <ids>] [--arms <ids>]   # prompts and arm setup for a manual run
npm run bench:agent -- --score <answers.json> [--out <dir>]            # report.json + report.md, verdicts per class
```

Both modes first check every answer-key path and evidence symbol against the pinned commit, from git objects only, and stop on a wrong key.

Live mode, Claude Code on the claude.ai subscription only (`npm run build` first for the graph arm):

```sh
npm run bench:agent -- --client claude --dry-run [--tasks <ids>] [--arms <ids>]  # prompts, commands, MCP configs; starts nothing
npm run bench:agent -- --client claude [--tasks <ids>] [--arms <ids>] [--out <dir>]
```

After the key check, it removes every API key, auth token, base URL and provider variable from the child environment, requires `claude auth status --json` to report a claude.ai login, and refuses to start otherwise. Each arm gets its own temporary copy of the corpus commit (`git archive`, so no `.git` history to read) without agent instruction files; the graph arm index is built once (cold time reported separately). Each run uses `claude -p --output-format stream-json` with a pinned model, `--effort low`, no settings sources (no user hooks, plugins or memories), `--strict-mcp-config` with the arm servers only, and a fixed tool list. A run is killed at init (and refused when no init event arrives) when the session uses an API key, loads a plugin other than the Claude Code `@builtin` ones (listed in the report) or another MCP server, or another model or effort. The benchmark stops at the first rate-limit, allowance, credits or overage message, and never retries; otherwise it reruns at most 6 cells (failed runs, then tasks whose arms disagree).

## Not the tool-selection eval

`tests/evals/toolSelection.eval.test.ts` (#165) asks one model, through `LlmClientFactory` and an API key, which MCP tool it would pick for a question. It measures tool descriptions, not task results.

This benchmark runs whole agent sessions on client subscriptions only (Claude Code, Codex, Copilot), never through an API key or `LlmClientFactory`. It scores the final answers against frozen keys and records tool calls, turns, latency and provider tokens. It keeps the dataset/report pattern and the opt-in principle of the tool-selection eval: no workflow runs it, and CI only runs its unit tests (`tests/scripts/benchAgent.test.ts`).
