/**
 * E2E Tests for native Language Model Tools registration.
 *
 * Verifies that after extension activation all 20 Graph-It-Live LM tools
 * are present in `vscode.lm.tools`.  Tests are skipped gracefully when the
 * VS Code host doesn't support `vscode.lm.tools` (pre-1.90 or non-Copilot
 * environments) so they never cause false failures on older CI agents.
 *
 * New tools added in session (v1.8.0):
 *   - graph-it-live_resolve_module_path
 *   - graph-it-live_analyze_breaking_changes
 *   - graph-it-live_query_call_graph
 */

import { before } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

// Minimum set of expected tool names (all 20).
const EXPECTED_TOOLS = [
  'graph-it-live_find_referencing_files',
  'graph-it-live_analyze_dependencies',
  'graph-it-live_crawl_dependency_graph',
  'graph-it-live_get_symbol_graph',
  'graph-it-live_find_unused_symbols',
  'graph-it-live_get_symbol_callers',
  'graph-it-live_get_impact_analysis',
  'graph-it-live_get_index_status',
  'graph-it-live_parse_imports',
  'graph-it-live_generate_codemap',
  'graph-it-live_expand_node',
  'graph-it-live_verify_dependency_usage',
  'graph-it-live_invalidate_files',
  'graph-it-live_rebuild_index',
  'graph-it-live_get_symbol_dependents',
  'graph-it-live_trace_function_execution',
  'graph-it-live_analyze_file_logic',
  // v1.8.0 batch 2
  'graph-it-live_resolve_module_path',
  'graph-it-live_analyze_breaking_changes',
  'graph-it-live_query_call_graph',
];

/** Returns true when vscode.lm.tools is supported by the current host. */
function lmToolsSupported(): boolean {
  return (
    typeof vscode.lm === 'object' &&
    vscode.lm !== null &&
    'tools' in vscode.lm &&
    Array.isArray((vscode.lm as unknown as { tools: unknown }).tools)
  );
}

/** Returns registered tools as a plain array, or [] when unsupported. */
function getRegisteredTools(): ReadonlyArray<{ name: string }> {
  if (!lmToolsSupported()) return [];
  return (vscode.lm as unknown as { tools: ReadonlyArray<{ name: string }> }).tools;
}

suite('LM Tools Registration Test Suite', () => {
  before(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  test('vscode.lm.registerTool is supported in this VS Code version', function () {
    const supported = typeof (vscode.lm as Record<string, unknown>).registerTool === 'function';
    if (!supported) {
      this.skip();
    }
    assert.ok(supported, 'vscode.lm.registerTool should be a function');
  });

  test('All 20 Graph-It-Live LM tools are registered', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const registeredNames = new Set(getRegisteredTools().map((t) => t.name));

    const missing = EXPECTED_TOOLS.filter((name) => !registeredNames.has(name));
    assert.strictEqual(
      missing.length,
      0,
      `Missing LM tools: ${missing.join(', ')}`,
    );
  });

  test('resolve_module_path tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'graph-it-live_resolve_module_path');
    assert.ok(tool, 'graph-it-live_resolve_module_path should be registered');
  });

  test('analyze_breaking_changes tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'graph-it-live_analyze_breaking_changes');
    assert.ok(tool, 'graph-it-live_analyze_breaking_changes should be registered');
  });

  test('query_call_graph tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'graph-it-live_query_call_graph');
    assert.ok(tool, 'graph-it-live_query_call_graph should be registered');
  });

  test('Total Graph-It-Live tool count is exactly 20', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tools = getRegisteredTools();
    const graphItLiveTools = tools.filter((t) => t.name.startsWith('graph-it-live_'));
    assert.strictEqual(
      graphItLiveTools.length,
      20,
      `Expected 20 graph-it-live tools, found ${graphItLiveTools.length}: ${graphItLiveTools.map((t) => t.name).join(', ')}`,
    );
  });
});
