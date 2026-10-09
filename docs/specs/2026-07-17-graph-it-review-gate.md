# Graph-It Review Gate

## Contract

`ReviewGateAnalyzer` compares `baseRef` to the current worktree by default, or to an explicit `headRef`. Inputs are bounded: `maxFiles` 1–1000 and `maxDepth` 1–10. Output contains sorted changed files, per-symbol evidence, explicit score factors, cycle and unused-export evidence when the warmed Spider capabilities are available, conventional test-file candidates, score, risk (`low`, `medium`, `high`, `critical`), and `isPartial`/limitations.

## Risk model

A symbol without an error-level breaking change scores 0. Otherwise the breaking finding contributes once per symbol: 50 points, 25 when a test covers the change, or 5 (residual) when impact is confirmed zero, when consumers need not act (`consumersMustAct` is false: only return types changed), or when the diff updates every consumer. When consumers must act, each consumer the diff does not touch (covered or unverified) contributes 5 points, and a partial impact walk contributes 10 points. A detected symbol cycle contributes 20 points, an unused changed export 10 points, and no conventional test-file candidate 10 points. The per-symbol score is capped at 100; the review score is the maximum symbol score. Thresholds: low < 20, medium < 50, high < 80, critical ≥ 80.

## Security and trust boundaries

Git is executed with `execFile`, never shell interpolation. Changed paths are resolved and verified inside the workspace before file I/O, then normalized before storage. The Action receives GitHub event metadata as untrusted input, writes a single marker-owned comment, escapes Markdown table/HTML control characters, and only calls GitHub when comments are requested. The default is informative; `fail-on-risk` must be `high` or `critical` to fail CI.

The VS Code URI is `vscode://magic5644.graph-it-live/graph-it-live.reviewCallGraph?file=<workspace-relative>&symbol=<optional>&depth=3`. It is emitted only for a risky symbol with a relative file. The extension accepts a canonical integer depth in 1–5, then revalidates the workspace-relative path (including rejecting the workspace root) before opening the existing Cytoscape call graph.

## External composite Action distribution

The composite Action is consumed from `magic5644/Graph-It-Live/.github/actions/graph-it-review-gate@v1.18.0`; it has no trigger and each consumer supplies a `pull_request` workflow with a full-history checkout. It installs `@magic5644/graph-it-live@latest` in an isolated temporary npm prefix by default. A non-empty `cli-version` input is passed as the package specifier, so it may be an exact version, tag, or range. The Action parses the actual CLI output (`graph-it-live vX.Y.Z`), exposes the resolved version, and rejects every effective version lower than `1.13.0`, including prereleases of that minimum.

The Action does not run `npm ci`, project scripts, or local builds in the consumer checkout. It invokes the installed CLI with `--workspace "$GITHUB_WORKSPACE"`. Consumer workflows must use `pull_request`, never `pull_request_target`, for untrusted code. Comments require `pull-requests: write` and should be disabled (`comment: false`) for fork PRs; read-only analysis requires only `contents: read`. npm publication, public `npx` verification, and creation of an immutable release tag are manual post-merge release steps.

## Limits

v1 detects TypeScript/JavaScript signature breaks in changed comparable files. Non-source changed files, cycle and unused-export findings without a warmed Spider capability, added/deleted/unreadable files, and bounded file/depth traversal are explicitly partial. Test candidates are conventional file-name matches, not proof that tests cover a change. It does not claim complete semantic call resolution, test coverage, or remote GitHub-App analysis.
