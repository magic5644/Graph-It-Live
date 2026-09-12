# Graph-It-Live agent plugin

This portable Agent Plugin bundles the Graph-It-Live MCP server and the
Graph-It-Live skills (`graph-it-live`, `onboarding-express`, `dead-code-hunter`,
and `pr-review`) from [magic5644/skills](https://github.com/magic5644/skills).

Install the plugin from its repository with the installation mechanism provided
by your client. Agent Plugins compatible clients use `plugin.json`, `mcp.json`,
and `skills/`; Claude Code and Codex also find their native manifests in
`.claude-plugin/` and `.codex-plugin/`.

Examples:

- Claude Code: `claude --plugin-dir ./plugins/graph-it-live` (or install it from a marketplace).
- GitHub Copilot CLI: `copilot plugin install ./plugins/graph-it-live`.
- VS Code: run **Chat: Install Plugin From Source** and select this directory.
- Cursor: install the directory from the Plugins panel.
- Codex: add the directory to a configured plugin marketplace, then use `/plugins`.

The MCP command deliberately uses `@latest`, so the CLI and its bundled MCP
server are always resolved from the same published npm package. The CLI also
checks for updates and reports `graph-it update`; run `scripts/update-cli.sh`
when an explicit update is needed.

The three plugin manifests carry the current published CLI version. The
repository workflow updates them automatically after an npm publish.
