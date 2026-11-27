/**
 * Serves the agent skills bundled in dist/skills/ (copied from
 * plugins/graph-it-live/skills/ by esbuild.js) through the MCP Skills extension.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";

/**
 * Attaches the skills found under `root` to `server` (before it connects) and
 * returns how many it serves. Missing or unreadable skills never stop the
 * server: `warn` gets one line and the tools still start.
 */
export async function attachBundledSkills(
  server: McpServer,
  root: string,
  warn: (message: string) => void,
): Promise<number> {
  if (!fs.existsSync(root)) {
    warn(`[McpServer] WARNING: bundled skills folder not found: ${root}; serving tools only (reinstall the package)`);
    return 0;
  }
  const problems: string[] = [];
  try {
    const catalog = await loadSkills(root, { onWarning: ({ path, message }) => problems.push(`${path}: ${message}`) });
    if (catalog.entries.length > 0) {
      catalog.attach(server);
      for (const problem of problems) warn(`[McpServer] WARNING: skill skipped, ${problem}`);
      return catalog.entries.length;
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message.split("\n").map((line) => line.trim()).join(" ") : String(error));
  }
  warn(`[McpServer] WARNING: no skills served from ${root} (${problems.join("; ")}); serving tools only`);
  return 0;
}
