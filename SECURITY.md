# Security Policy

## Supported versions

Only the latest published release of the VS Code extension, the CLI (`graph-it`) and the MCP server receives security fixes.

## Reporting a vulnerability

**Do not open a public issue or pull request for a vulnerability.**

Use GitHub's private advisory form: [Report a vulnerability](https://github.com/magic5644/Graph-It-Live/security/advisories/new) (repository **Security** tab → **Report a vulnerability**).

Include:

- the affected component (`src/analyzer`, `src/mcp`, CLI, webview, CI workflow, package) and version;
- steps to reproduce, with a minimal neutral fixture (no private code);
- the impact you observed (for example path traversal, arbitrary file read, command execution);
- a suggested fix, if you have one.

## What to expect

- Acknowledgement of the report, then a triage with a severity.
- A fix developed in the private advisory, released as a patch version.
- Public credit in the advisory, unless you prefer to stay anonymous.

Please allow time for a fix before any public disclosure.

## Scope

In scope: path handling and workspace-boundary checks, MCP and CLI input validation, webview message handling, packaging (the VSIX and the npm package), and the GitHub Actions workflows.

Out of scope: vulnerabilities in third-party dependencies with no exploitable path in Graph-It-Live (report them upstream), and issues requiring an already compromised machine or workspace.
