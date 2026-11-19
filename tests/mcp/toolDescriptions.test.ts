/**
 * Tool description registry tests
 *
 * src/mcp/toolDescriptions.ts is the single source for the MCP descriptions,
 * the `graph-it tool --list` summaries and the LM tool modelDescription fields
 * in package.json. These tests fail when package.json drifts from it
 * (fix with `npm run sync:tool-descriptions`) or when an LM description leaks
 * MCP-only names or parameters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DescribedToolName,
  lmToolDescription,
  mcpToolDescription,
  toolSummary,
} from '../../src/mcp/toolDescriptions';
import { toolSchemas } from '../../src/mcp/types';
import { schemaParameters } from '../../src/mcp/paramIssues';

interface LmToolContribution {
  name: string;
  modelDescription: string;
}

const LM_PREFIX = 'graph-it-live_';
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { contributes: { languageModelTools: LmToolContribution[] } };
const lmTools = manifest.contributes.languageModelTools;
const lmToolNames = new Set(lmTools.map((tool) => tool.name));
const shortName = (tool: LmToolContribution) =>
  tool.name.slice(LM_PREFIX.length) as DescribedToolName;

describe('tool descriptions registry', () => {
  it.each(lmTools.map((tool) => [tool.name, tool] as const))(
    'package.json modelDescription of %s matches the registry',
    (_name, tool) => {
      const properties = Object.keys((tool as LmToolContribution & { inputSchema: { properties: object } }).inputSchema.properties);
      expect(tool.modelDescription).toBe(lmToolDescription(shortName(tool), properties));
    },
  );

  it('LM descriptions name only registered LM tools', () => {
    for (const tool of lmTools) {
      const text = lmToolDescription(shortName(tool));
      expect(text).not.toContain('graphitlive_');
      for (const [ref] of text.matchAll(/graph-it-live_[a-z_]+/g)) {
        expect(lmToolNames, `${tool.name} references ${ref}`).toContain(ref);
      }
    }
  });

  it('MCP descriptions name only registered MCP tools (issue #304)', () => {
    const mcpToolNames = new Set([...Object.keys(toolSchemas), 'get_session_stats']);
    for (const name of mcpToolNames) {
      for (const [, ref] of mcpToolDescription(name as DescribedToolName).matchAll(/graphitlive_([a-z_]+)/g)) {
        expect(mcpToolNames, `${name} references graphitlive_${ref}`).toContain(ref);
      }
    }
  });

  it('every description names every parameter of its tool, on both surfaces (#769)', () => {
    for (const tool of lmTools) {
      const properties = Object.keys((tool as LmToolContribution & { inputSchema: { properties: object } }).inputSchema.properties);
      for (const parameter of properties) {
        expect(tool.modelDescription, `${tool.name} names ${parameter}`).toMatch(new RegExp(String.raw`\b${parameter}\b`));
      }
    }
  });

  it('gives an LM tool with an MCP twin exactly the MCP parameters (#769)', () => {
    for (const tool of lmTools as Array<LmToolContribution & { inputSchema: { properties: object; additionalProperties?: boolean } }>) {
      const schema = (toolSchemas as Record<string, Parameters<typeof schemaParameters>[0]>)[shortName(tool)];
      if (schema === undefined) continue;
      expect(Object.keys(tool.inputSchema.properties), tool.name).toEqual([...schemaParameters(schema), 'response_format']);
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('starts every description with its summary and keeps surface-only lines apart', () => {
    expect(mcpToolDescription('crawl_dependency_graph')).toMatch(/^Builds the transitive file dependency graph[^\n]*\n\nWHEN:/);
    expect(mcpToolDescription('crawl_dependency_graph')).toContain('LIMITS: output capped by tokenBudget');
    // The LM tool runs the MCP crawl (#769): same paging, same LIMITS line.
    expect(lmToolDescription('crawl_dependency_graph')).toContain('LIMITS: output capped by tokenBudget');
    expect(lmToolDescription('scan_dead_code')).not.toContain('LIMITS: needs background indexing');
    expect(mcpToolDescription('query_call_graph')).toContain('graphitlive_find_referencing_files');
    expect(lmToolDescription('query_call_graph')).toContain('graph-it-live_find_referencing_files');
    expect(toolSummary('get_symbol_graph')).toBe(mcpToolDescription('get_symbol_graph').split('\n')[0]);
  });
});
