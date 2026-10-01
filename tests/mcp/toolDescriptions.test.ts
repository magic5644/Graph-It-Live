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
      expect(tool.modelDescription).toBe(lmToolDescription(shortName(tool)));
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

  it('LM descriptions do not advertise MCP-only paging or output parameters', () => {
    for (const tool of lmTools) {
      expect(lmToolDescription(shortName(tool)), tool.name).not.toMatch(/nextOffset|response_format/);
    }
    // Only the LM get_symbol_callers schema has includeTypeOnly.
    expect(lmToolDescription('query_call_graph')).not.toContain('includeTypeOnly');
  });

  it('starts every description with its summary and keeps surface-only lines apart', () => {
    expect(mcpToolDescription('expand_node')).toMatch(/^Returns the dependencies of one file[^\n]*\n\nWHEN:/);
    expect(mcpToolDescription('expand_node')).toContain('LIMITS: output capped by tokenBudget');
    expect(lmToolDescription('expand_node')).not.toContain('LIMITS:');
    expect(mcpToolDescription('query_call_graph')).toContain('graphitlive_find_referencing_files');
    expect(lmToolDescription('query_call_graph')).toContain('graph-it-live_find_referencing_files');
    expect(toolSummary('get_symbol_graph')).toBe(mcpToolDescription('get_symbol_graph').split('\n')[0]);
  });
});
