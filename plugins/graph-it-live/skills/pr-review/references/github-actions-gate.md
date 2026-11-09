# Graph-It Review Gate for GitHub Actions

Read on demand from the `pr-review` skill when creating or modernizing a workflow.

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

Action outputs: `risk`, `score`, `cli-version`, `architecture-new-errors` (new unaccepted `error` violations of `graphit.architecture.json`; any fails the gate).

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
