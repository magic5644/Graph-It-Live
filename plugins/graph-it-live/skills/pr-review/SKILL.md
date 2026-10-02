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

## CLI and Capability Discovery

Prefer the Graph-It CLI. At the first activation of any Graph-It skill in a session, check
`graph-it --version` when the CLI and terminal are available; use only its existing newer-version
notice and do not poll npm. Share discovery, version, and update decisions across Graph-It skills
for the session. Run `graph-it tool --list` once, consult `graph-it --help` or command help as
needed, and refresh only when the CLI/version, server, or workspace changes or a requested tool is
unknown. Examples are illustrative, not a fixed inventory. Do not install automatically. If the
CLI is unavailable or unsuitable, use MCP only when the connected host advertises a structurally
equivalent tool and its schema; otherwise explain the gap. `graph-it tool <name>` invokes analysis
directly through CLI; `graph-it serve` starts MCP. CLI `--format` and MCP `response_format` are
distinct.

If the CLI reports a newer version, interactive use requires explicit positive confirmation before
running `graph-it update`; silence, timeout, refusal, non-TTY, or generic Agent mode is not consent.
When automatic mode is explicitly enabled and pre-authorized, default the update decision to yes and
run `graph-it update` without another prompt. After success, refresh the version and `--list`,
invalidate cached capabilities, and advise that a running MCP server needs a host-authorized restart.
On failure, keep using the existing CLI only if it remains usable; otherwise explain the failure
and stop CLI analysis. Warn briefly and do not retry in a loop. Do not install the CLI without an
explicit request.

Fetch the Git base ref needed for review. Run commands from the repository root; the CLI indexes
automatically for `review-pr`, so do not run `graph-it scan` first.

## Local Review Workflow

### 1. Analyze the diff

```bash
graph-it review-pr --base origin/main --format markdown
```

Use explicit limits when needed:

```bash
graph-it review-pr --base origin/main --head feature/my-change --depth 3 --max-files 200 --format toon
```

- `--base` is required.
- Without `--head`, the command reviews the current working tree, including staged and unstaged contents.
- With `--head <ref>`, both sides are committed Git refs; untracked working-tree files are excluded.
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

These examples illustrate CLI use; verify tool names and parameters in the installed inventory/help.
For MCP fallback, use only a structurally equivalent tool advertised by the connected host and its
exact input schema. Use absolute paths when the selected CLI parameter requires them:

```bash
# Blast radius and known dependent symbols
graph-it tool get_impact_analysis --filePath=/absolute/path/src/api.ts --symbolName=updateUser --format=toon

# Direct callers for a specific symbol
graph-it tool query_call_graph --filePath=/absolute/path/src/api.ts --symbolName=updateUser --direction=callers --depth=1 --format=toon

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

When creating or modernizing a workflow, resolve the latest stable **official GitHub release**
first, then resolve that release tag to its full commit SHA (dereference annotated tags when
needed). Pin the action to that SHA and comment the corresponding release tag. Do not trust
`target_commitish` as the tag's commit, use a floating ref, or copy this dated example without
resolving the current release. This is a verified snapshot of `v1.17.0` as of 2026-10-02, not a
claim that it remains the latest release:

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
      - uses: magic5644/Graph-It-Live/.github/actions/graph-it-review-gate@2f9d5cd9756c8add33e7a2b30e34be7c131048ac # v1.17.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          comment: ${{ github.event.pull_request.head.repo.fork && 'false' || 'true' }}
          fail-on-risk: high
          max-depth: "3"
          max-files: "200"
          cli-version: "" # empty installs the npm CLI @latest; independent of the pinned Action SHA
```

Action inputs:

- `token` — required only when `comment: true`.
- `base-ref` — optional; defaults to the pull request base SHA when available.
- `comment` — updates a sticky pull-request comment; disable for fork PRs.
- `fail-on-risk` — optional `high` or `critical` threshold; leave empty for an informative gate.
- `cli-version` — optional npm version, tag, or range; empty installs `latest`.
- `max-depth` and `max-files` — control bounded analysis.

Action outputs: `risk`, `score`, `cli-version`.

Use Dependabot to propose Action reference updates. Merge this entry into an existing
`.github/dependabot.yml` rather than replacing other update configuration; Dependabot opens PRs and
does not auto-merge them unless separately configured:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
```

Use least privilege: remove `pull-requests: write` and set `comment: false` if comments are not needed.
Do not expose write tokens to untrusted fork code.

## Boundaries

- Review `review-pr` as a Git-diff risk signal, not a replacement for unit, integration, security, or human domain review.
- Verify changed non-JS/TS files manually when they appear in limitations; signature analysis supports TypeScript and JavaScript extensions.
- Run `graph-it scan` before unrelated follow-up tool calls if the repository changed after the review run.
- Use **graph-it-live** for architecture and impact questions outside a diff, and **dead-code-hunter** for an intentional cleanup sweep.
