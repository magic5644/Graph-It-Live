# Graph-It-Live agent plugin

This portable Agent Plugin bundles the Graph-It-Live MCP server and the
Graph-It-Live skills (`graph-it-live`, `onboarding-express`, `dead-code-hunter`,
and `pr-review`) from [magic5644/skills](https://github.com/magic5644/skills).

Install the plugin from its repository with the installation mechanism provided
by your client. Agent Plugins compatible clients use `plugin.json`, `mcp.json`,
and `skills/`; Claude Code and Codex also find their native manifests in
`.claude-plugin/` and `.codex-plugin/`.

Examples:

- Claude Code: `claude plugin marketplace add magic5644/Graph-It-Live`, then `/plugin install graph-it-live@graph-it-live` (or use `claude --plugin-dir ./plugins/graph-it-live` for a local session).
- GitHub Copilot CLI: `copilot plugin marketplace add magic5644/Graph-It-Live`, then `copilot plugin install graph-it-live@graph-it-live`.
- VS Code: run **Chat: Install Plugin From Source** and select this directory.
- Cursor: install the directory from the Plugins panel.
- Codex: add this repository’s `.agents/plugins/marketplace.json` to a configured marketplace, then use `/plugins`.

The MCP command runs `npx -y --prefer-offline @magic5644/graph-it-live@<version> serve`.
The pinned version starts from the npx cache without a registry lookup; npx
downloads the package only on the first start or after a version change. The
CLI also checks for updates and reports `graph-it update`; run
`scripts/update-cli.sh` when an explicit update is needed.

`plugin.json` is the single source for the shared plugin fields. After each
npm publish, the repository workflow runs
`node scripts/sync-agent-plugin-version.mjs`, which writes the published
version into every manifest and derives `.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `mcp.json`, `.mcp.json` and the Claude marketplace
entry. Do not edit those derived fields by hand: the
`tests/scripts/syncAgentPluginVersion.test.ts` drift test fails.
