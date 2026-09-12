---
name: pr-review
description: |
  Review pull requests and Git diffs with Graph-It-Live risk, breaking-change, dependency-impact,
  cycle, unused-export, and test-candidate evidence. Use when asked to review a PR, inspect a diff,
  assess merge risk, check a branch before merging, create a Graph-It-Live review gate, or explain
  review-pr results. Trigger for: "review this PR", "review this diff", "is this safe to merge",
  "check merge risk", "analyze changed files", "PR review", "code review my branch", "revoir cette PR",
  "analyser ce diff", "risque de merge".
argument-hint: 'Which Git base ref or pull request diff should be reviewed?'
context: fork
---

# Graph-It-Live PR Review

Use deterministic local diff analysis first. Deepen only findings that need additional evidence.

## Prerequisites

```bash
npm install -g @magic5644/graph-it-live
git fetch origin main
```

Run commands from the repository root. The CLI indexes automatically for `review-pr`.

## Local Review Workflow

### 1. Analyze the diff

```bash
graph-it review-pr --base origin/main --format markdown
```

Use explicit limits when needed:

```bash
graph-it review-pr --base origin/main --head HEAD --depth 3 --max-files 200 --format toon
```

- `--base` is required.
- `--head` defaults to `HEAD`.
- `--depth` limits transitive dependent traversal; use an integer from 1 to 10.
- `--max-files` limits changed files; use an integer from 1 to 1000.
- Use `--format markdown` for a human report; use `toon` or `json` for structured agent analysis.

### 2. Interpret evidence before concluding

The report includes a top-level `risk`, `score`, `changedFiles`, `symbols`, `limitations`, and `isPartial`.

| Risk | Meaning | Review action |
| --- | --- | --- |
| `low` | No high-scoring static concern | Review behavioral changes and tests normally |
| `medium` | Inspect changed symbol and direct dependents | Request focused validation when evidence is unresolved |
| `high` | Breaking or broad-impact evidence | Block until compatibility, callers, and tests are addressed |
| `critical` | Highest static risk | Block; require explicit mitigation and targeted verification |

Never call a review complete when `isPartial` is `true` or `limitations` is non-empty. Limitations can
mean unsupported file types, added/deleted/unreadable files, parser failures, unavailable cycle/unused
analysis, configured file limits, or an impact traversal that reached its depth limit.

No reported breaking signature does **not** establish behavioral safety. Static evidence supplements;
it does not replace tests, security review, or domain review.

### 3. Deepen high-risk findings

Use absolute paths for all `graph-it tool` file parameters:

```bash
# Blast radius and known dependent symbols
graph-it tool get_impact_analysis --filePath=/absolute/path/src/api.ts --symbolName=updateUser --format=toon

# Direct callers for a specific symbol
graph-it tool get_symbol_callers --filePath=/absolute/path/src/api.ts --symbolName=updateUser --format=toon

# Broader caller/callee neighbourhood
graph-it tool query_call_graph --filePath=/absolute/path/src/api.ts --symbolName=updateUser --depth=3 --format=toon

# Understand a changed implementation and its local call flow
graph-it tool generate_codemap --filePath=/absolute/path/src/api.ts --format=toon
```

Check conventional test candidates reported by `review-pr`, then inspect the actual tests. Missing test
candidates mean manual test selection is required, not that testing is unnecessary.

## Required Review Output

Produce findings in this order:

1. **Verdict** — approve, approve with follow-ups, or changes requested. State whether analysis was partial.
2. **Blocking findings** — risk, file/symbol, concrete evidence, requested fix.
3. **Non-blocking findings** — risk, evidence, and follow-up.
4. **Test assessment** — existing candidates, missing coverage, checks still required.
5. **Limitations** — every limitation verbatim or faithfully summarized; list the manual check that closes it.

Do not invent runtime behavior from graph data. Cite the command output that supports each claim.

## GitHub Actions Gate

Use the published composite action in a consumer workflow:

```yaml
name: Graph-It Review Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: magic5644/Graph-It-Live/.github/actions/graph-it-review-gate@v1.13.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          comment: ${{ github.event.pull_request.head.repo.fork && 'false' || 'true' }}
          fail-on-risk: high
          max-depth: "3"
          max-files: "200"
```

Action inputs:

- `token` — required only when `comment: true`.
- `base-ref` — optional; defaults to the pull request base SHA when available.
- `comment` — updates a sticky pull-request comment; disable for fork PRs.
- `fail-on-risk` — optional `high` or `critical` threshold; leave empty for an informative gate.
- `cli-version` — optional npm version, tag, or range; empty installs `latest`.
- `max-depth` and `max-files` — control bounded analysis.

Action outputs: `risk`, `score`, `cli-version`.

Use least privilege: remove `pull-requests: write` and set `comment: false` if comments are not needed.
Do not expose write tokens to untrusted fork code.

## Boundaries

- Review `review-pr` as a Git-diff risk signal, not a replacement for unit, integration, security, or human domain review.
- Verify changed non-JS/TS files manually when they appear in limitations; signature analysis supports TypeScript and JavaScript extensions.
- Run `graph-it scan` before unrelated follow-up tool calls if the repository changed after the review run.
- Use **graph-it-live** for architecture and impact questions outside a diff, and **dead-code-hunter** for an intentional cleanup sweep.
