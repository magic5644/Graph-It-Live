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

## Not the tool-selection eval

`tests/evals/toolSelection.eval.test.ts` (#165) asks one model, through `LlmClientFactory` and an API key, which MCP tool it would pick for a question. It measures tool descriptions, not task results.

This benchmark runs whole agent sessions on client subscriptions only (Claude Code, Codex, Copilot), never through an API key or `LlmClientFactory`. It scores the final answers against frozen keys and records tool calls, turns, latency and provider tokens. It keeps the dataset/report pattern and the opt-in principle of the tool-selection eval: no workflow runs it, and CI only runs its unit tests (`tests/scripts/benchAgent.test.ts`).
