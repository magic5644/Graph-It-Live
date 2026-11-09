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

## Setup, routing and format

- Prefer the Graph-It CLI. At the first activation of any Graph-It skill in a session, run
  `graph-it --version` and `graph-it tool --list` once and share them across Graph-It skills. Requires
  CLI **1.21.0 or later**: if older or unreadable, say so, name the missing commands, offer
  `graph-it update`, and use only what `--help` and `tool --list` show. Do not install the CLI without
  an explicit request. Without it, use only a structurally equivalent MCP tool the host advertises,
  with its exact input schema; CLI options do not map to MCP parameters.
- Run `graph-it update` only after explicit positive confirmation; silence, timeout, refusal, non-TTY
  or generic Agent mode is not consent, an explicitly pre-authorized automatic mode is. After success,
  refresh version and inventory; a running MCP server needs a host-authorized restart. On failure, keep
  a usable CLI, warn once, do not retry.
- Routing: `review-pr` comes first; then read the changed hunks and the files its findings name,
  bounded, instead of re-exploring the repository.
- Format: `--format toon` for everything you read; `json` only when a script parses the output;
  `markdown` only when the report itself goes to a human or a PR comment.

Review from the repository (monorepo) root with `graph-it -w <repoRoot> review-pr ...` so consumers in
every package count. Without `-w` the CLI uses the nearest project marker (`package.json`,
`pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `*.csproj`, ...), which inside a sub-package
leaves siblings out, and exits with code `3` outside any project. If stderr warns that imports resolve
outside the workspace root, rerun with the `--workspace` it names or state the limitation.

## Local Review Workflow

### 1. Analyze the diff

Fetch the base ref first. `review-pr` indexes automatically: do not run `graph-it scan` before it.

```bash
graph-it review-pr --base origin/main --format toon
graph-it review-pr --base origin/main --head feature/my-change --depth 3 --max-files 200 --format toon
```

- `--base` is required. Without `--head`, the working tree is reviewed, staged and unstaged included.
- With `--head <ref>`, both sides are committed refs; untracked files are excluded.
- `--depth` limits transitive dependent traversal (1-10); `--max-files` caps changed files (default 200, at least 1, no upper bound).

With `graphit.architecture.json` at the workspace root (or edited by the diff), the report has an
`architecture` section comparing the rules on base and head: `verdict` (`degraded`, `improved`,
`unchanged`), each rule's `newViolations` (`accepted` when the head baseline lists them),
`resolvedViolations`, new `unitCycles`, and `configChange`. `newErrors` > 0 blocks the merge and fails
the Review Gate. A `configChange` that weakens or removes a rule or accepts new baseline entries is a
finding to justify. `graph-it check-architecture --format toon` gives the whole-workspace check
(`--verbose` lists accepted violations in text/markdown).

### 2. Interpret evidence before concluding

The report includes a top-level `risk`, `score`, `changedFiles`, `symbols`, `cycles`, `limitations`, and `isPartial`, plus `architecture` with a rules file.

| Risk | Meaning | Review action |
| --- | --- | --- |
| `low` | No high-scoring static concern | Review behavioral changes and tests normally |
| `medium` | Inspect changed symbol and direct dependents | Request focused validation when evidence is unresolved |
| `high` | Breaking or broad-impact evidence | Block until compatibility, callers, and tests are addressed |
| `critical` | Highest static risk | Block; require explicit mitigation and targeted verification |

Never call a review complete when `isPartial` is `true` or `limitations` is non-empty. Limitations can
mean unsupported file types, unreadable files (symbolic links, binaries, files over 2 MiB), parser failures, unavailable cycle/unused
analysis, configured file limits, or an impact traversal that reached its depth limit.

No reported breaking signature does **not** establish behavioral safety. Static evidence supplements;
it does not replace tests, security review, or domain review.

### 3. Deepen high-risk findings

Verify parameters with `graph-it tool <name> --help`; MCP fallback uses only the host-advertised schema.

```bash
# Blast radius and known dependent symbols
graph-it tool get_impact_analysis --filePath=/abs/src/api.ts --symbolName=updateUser --format toon

# Direct callers for a specific symbol
graph-it tool query_call_graph --filePath=/abs/src/api.ts --symbolName=updateUser --direction=callers --depth=1 --format toon

# Broader caller/callee neighbourhood
graph-it tool query_call_graph --filePath=/abs/src/api.ts --symbolName=updateUser --depth=3 --format toon

# Understand a changed implementation and its local call flow
graph-it tool generate_codemap --filePath=/abs/src/api.ts --format toon
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

To create or modernize the `graph-it-review-gate` workflow, read `references/github-actions-gate.md`:
pin the Action to the full commit SHA of the latest official release, least-privilege permissions,
no write token for fork code, and Dependabot for Action updates.

## Boundaries

- Review `review-pr` as a Git-diff risk signal, not a replacement for unit, integration, security, or human domain review.
- Verify changed non-JS/TS files manually when they appear in limitations; signature analysis supports TypeScript and JavaScript extensions.
- Run `graph-it scan` before unrelated follow-up tool calls if the repository changed after the review run.
- Use **graph-it-live** for architecture and impact questions outside a diff, and **dead-code-hunter** for an intentional cleanup sweep.
