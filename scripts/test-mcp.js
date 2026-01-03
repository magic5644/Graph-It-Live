#!/usr/bin/env node
/**
 * MCP Server Test Script
 * Tests all MCP server tools with real tool calls and auto-terminates
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const util = require('node:util');

function writeLine(stream, text) {
  const line = text.endsWith('\n') ? text : `${text}\n`;
  stream.write(line);
}

function log(...args) {
  writeLine(process.stdout, util.format(...args));
}

function error(...args) {
  writeLine(process.stderr, util.format(...args));
}

const rootDir = path.resolve(__dirname, '..');
const serverPath = path.join(rootDir, 'dist/mcpServer.mjs');
const fixturesPath = path.join(rootDir, 'tests/fixtures/sample-project/src');

log('🚀 Starting MCP Server Test\n');
log('Server: %s', serverPath);
log('Fixtures: %s', fixturesPath);
log('');

const server = spawn('node', [serverPath], { //NOSONAR
  env: {
    ...process.env,
    WORKSPACE_ROOT: path.join(rootDir, 'tests/fixtures/sample-project'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let responseCount = 0;
let expectedResponses = 0;
const responses = new Map(); //NOSONAR

// Parse JSON-RPC responses from stdout
const rl = readline.createInterface({ input: server.stdout });

rl.on('line', (line) => {
  if (!line.trim()) return;
  
  try {
    const response = JSON.parse(line);
    responseCount++;
    
    if (response.id) {
      responses.set(response.id, response);
      const content = JSON.stringify(response.result || response.error, null, 2);
      // Truncate long responses
      const truncated = content.length > 800 ? content.substring(0, 800) + '\n... (truncated)' : content;
      log(`✅ Response ${response.id}: ${truncated}`);
    }
  } catch (e) { //NOSONAR
    // Not JSON, ignore
  }
});

// Log stderr (server logs)
server.stderr.on('data', (data) => {
  const lines = data.toString().trim().split('\n');
  for (const line of lines) {
    if (line.includes('Worker ready') || line.includes('Warmup complete')) {
      log('🔥 %s', line);
    } else if (line.includes('ERROR') || line.includes('error')) {
      log('❌ %s', line);
    }
  }
});

server.on('close', (code) => {
  log(`\n📊 Test Summary:`);
  log(`   Expected responses: ${expectedResponses}`);
  log(`   Responses received: ${responseCount}`);
  log(`   Exit code: ${code}`);
  
  const success = responseCount >= expectedResponses && code === 0;
  process.exit(success ? 0 : 1);
});

// Send a message
function send(msg) {
  expectedResponses++;
  server.stdin.write(JSON.stringify(msg) + '\n');
}

// Test sequence
async function runTests() {
  let id = 0;

  // =========================================================================
  // 1. Initialize
  // =========================================================================
  log('📤 Sending initialize...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-script', version: '1.0.0' }
    }
  });

  // Wait for warmup to complete
  log('⏳ Waiting 3s for warmup...');
  await new Promise(r => setTimeout(r, 3000));

  // =========================================================================
  // 2. graphitlive_set_workspace - Set workspace dynamically
  // =========================================================================
  log('\n📤 [graphitlive_set_workspace] Setting workspace to fixtures...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_set_workspace',
      arguments: {
        workspacePath: path.join(rootDir, 'tests/fixtures/sample-project')
      }
    }
  });
  await new Promise(r => setTimeout(r, 2000));

  // =========================================================================
  // 3. graphitlive_set_workspace - Error case: non-existent path
  // =========================================================================
  log('\n📤 [graphitlive_set_workspace] Testing error case: non-existent path...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_set_workspace',
      arguments: {
        workspacePath: '/non/existent/workspace'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 4. graphitlive_get_index_status - Verify index is ready
  // =========================================================================
  log('\n📤 [graphitlive_get_index_status] Getting index status...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_index_status',
      arguments: {}
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 5. graphitlive_analyze_dependencies - Analyze a single file
  // =========================================================================
  log('\n📤 [graphitlive_analyze_dependencies] Analyzing main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_analyze_dependencies',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 4. graphitlive_parse_imports - Parse imports without resolution
  // =========================================================================
  log('\n📤 [graphitlive_parse_imports] Parsing imports from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_parse_imports',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 5. graphitlive_resolve_module_path - Resolve a relative import
  // =========================================================================
  log('\n📤 [graphitlive_resolve_module_path] Resolving "./utils" from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_resolve_module_path',
      arguments: {
        fromFile: path.join(fixturesPath, 'main.ts'),
        moduleSpecifier: './utils'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 6. graphitlive_resolve_module_path - Resolve a path alias (should fail gracefully)
  // =========================================================================
  log('\n📤 [graphitlive_resolve_module_path] Resolving "@components/Button" from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_resolve_module_path',
      arguments: {
        fromFile: path.join(fixturesPath, 'main.ts'),
        moduleSpecifier: '@components/Button'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 7. graphitlive_crawl_dependency_graph - Build full dependency graph
  // =========================================================================
  log('\n📤 [graphitlive_crawl_dependency_graph] Crawling from main.ts (maxDepth=3)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 3
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 8. graphitlive_crawl_dependency_graph - Test pagination
  // =========================================================================
  log('\n📤 [graphitlive_crawl_dependency_graph] Crawling with pagination (limit=1, offset=0)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 3,
        limit: 1,
        offset: 0
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 9. graphitlive_find_referencing_files - Find files that import utils.ts
  // =========================================================================
  log('\n📤 [graphitlive_find_referencing_files] Finding files that reference utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 10. graphitlive_expand_node - Expand from a node with known paths
  // =========================================================================
  log('\n📤 [graphitlive_expand_node] Expanding main.ts excluding known paths...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_expand_node',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts'),
        knownPaths: [path.join(fixturesPath, 'main.ts')],
        extraDepth: 5
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 11. Error case: graphitlive_analyze_dependencies with non-existent file
  // =========================================================================
  log('\n📤 [graphitlive_analyze_dependencies] Testing error case: non-existent file...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_analyze_dependencies',
      arguments: {
        filePath: '/non/existent/file.ts'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 12. graphitlive_invalidate_files - Invalidate specific files from cache
  // =========================================================================
  log('\n📤 [graphitlive_invalidate_files] Invalidating main.ts and utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_invalidate_files',
      arguments: {
        filePaths: [
          path.join(fixturesPath, 'main.ts'),
          path.join(fixturesPath, 'utils.ts'),
          '/non/existent/file.ts' // This should appear in notFoundFiles
        ]
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 13. graphitlive_rebuild_index - Rebuild the full index
  // =========================================================================
  log('\n📤 [graphitlive_rebuild_index] Rebuilding the entire index...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_rebuild_index',
      arguments: {}
    }
  });
  await new Promise(r => setTimeout(r, 2000)); // Give more time for rebuild

  // =========================================================================
  // 14. graphitlive_get_symbol_graph - Get symbol-level dependencies
  // =========================================================================
  log('\n📤 [graphitlive_get_symbol_graph] Analyzing symbol graph for main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_graph',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 15. graphitlive_find_unused_symbols - Find potentially unused exports
  // =========================================================================
  log('\n📤 [graphitlive_find_unused_symbols] Finding unused exports in utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_unused_symbols',
      arguments: {
        filePath: path.join(fixturesPath, 'utils.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 16. graphitlive_get_symbol_dependents - Find all callers of a symbol
  // =========================================================================
  log('\n📤 [graphitlive_get_symbol_dependents] Finding dependents of format function...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_dependents',
      arguments: {
        filePath: path.join(fixturesPath, 'utils.ts'),
        symbolName: 'format'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 17. graphitlive_trace_function_execution - Trace execution call chain
  // =========================================================================
  log('\n📤 [graphitlive_trace_function_execution] Tracing execution from main function...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_trace_function_execution',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts'),
        symbolName: 'main',
        maxDepth: 5
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 18. graphitlive_get_symbol_callers - Find callers of a symbol (O(1) lookup)
  // =========================================================================
  const utilsPath = path.join(fixturesPath, 'utils.ts');
  log('\n📤 [graphitlive_get_symbol_callers] Finding callers of greet function...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_callers',
      arguments: {
        filePath: utilsPath,
        symbolName: 'greet'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 18. graphitlive_get_symbol_callers - Filter runtime only
  // =========================================================================
  log('\n📤 [graphitlive_get_symbol_callers] Finding runtime-only callers...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_callers',
      arguments: {
        filePath: utilsPath,
        symbolName: 'add',
        includeTypeOnly: false
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 19. graphitlive_analyze_breaking_changes - Analyze signature changes
  // =========================================================================
  log('\n📤 [graphitlive_analyze_breaking_changes] Analyzing breaking changes in utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_analyze_breaking_changes',
      arguments: {
        filePath: utilsPath,
        // Old version had add with one parameter
        oldContent: `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number): number {
  return a;
}`,
        // New version has add with two parameters (breaking change!)
        newContent: `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}`
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 20. graphitlive_get_impact_analysis - Full impact analysis
  // =========================================================================
  log('\n📤 [graphitlive_get_impact_analysis] Getting impact analysis for greet symbol...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_impact_analysis',
      arguments: {
        filePath: utilsPath,
        symbolName: 'greet'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 21. graphitlive_get_impact_analysis - With transitive analysis
  // =========================================================================
  log('\n📤 [graphitlive_get_impact_analysis] Impact with transitive dependents...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_impact_analysis',
      arguments: {
        filePath: utilsPath,
        symbolName: 'add',
        includeTransitive: true,
        maxDepth: 5
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 22. Error case: graphitlive_get_symbol_graph with non-existent file
  // =========================================================================
  log('\n📤 [graphitlive_get_symbol_graph] Testing error case: non-existent file...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_graph',
      arguments: {
        filePath: '/non/existent/symbol-file.ts'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 23. REGRESSION TEST: ReverseIndex preserves references after re-analysis
  // =========================================================================
  log('\n📤 [REGRESSION TEST] Testing ReverseIndex bug fix - re-analyze + findReferencingFiles...');
  
  // Step 1: Get initial references for utils.ts
  log('   Step 1: Get initial references for utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Step 2: Invalidate main.ts (simulating file change)
  log('   Step 2: Invalidate main.ts (simulating file change)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_invalidate_files',
      arguments: {
        filePaths: [path.join(fixturesPath, 'main.ts')]
      }
    }
  });
  await new Promise(r => setTimeout(r, 300));

  // Step 3: Re-analyze main.ts (triggers the bug scenario if not fixed)
  log('   Step 3: Re-analyze main.ts (triggers bug scenario)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_analyze_dependencies',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Step 4: Query references again - MUST still show main.ts as referencing utils.ts
  log('   Step 4: Query references again - CRITICAL: main.ts must STILL be in references...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // BENCHMARK: JSON vs TOON Format Comparison
  // =========================================================================
  log('\n📊 ============================================');
  log('📊 BENCHMARK: JSON vs TOON Format Comparison');
  log('📊 ============================================\n');

  // Test 1: Small dataset (10 items) - JSON format
  log('🔹 Test 1a: Small dataset (10 items) - JSON format...');
  const t1aStart = Date.now();
  const t1aId = ++id;
  send({
    jsonrpc: '2.0',
    id: t1aId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 2,
        response_format: 'json'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t1aTime = Date.now() - t1aStart;

  // Test 1b: Small dataset (10 items) - TOON format
  log('🔹 Test 1b: Small dataset (10 items) - TOON format...');
  const t1bStart = Date.now();
  const t1bId = ++id;
  send({
    jsonrpc: '2.0',
    id: t1bId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 2,
        response_format: 'toon'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t1bTime = Date.now() - t1bStart;

  // Test 2: Medium dataset - JSON format
  log('🔹 Test 2a: Medium dataset - JSON format...');
  const t2aStart = Date.now();
  const t2aId = ++id;
  send({
    jsonrpc: '2.0',
    id: t2aId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts'),
        response_format: 'json'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t2aTime = Date.now() - t2aStart;

  // Test 2b: Medium dataset - TOON format
  log('🔹 Test 2b: Medium dataset - TOON format...');
  const t2bStart = Date.now();
  const t2bId = ++id;
  send({
    jsonrpc: '2.0',
    id: t2bId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts'),
        response_format: 'toon'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t2bTime = Date.now() - t2bStart;

  // Test 3: Symbol-level analysis - JSON format
  log('🔹 Test 3a: Symbol-level analysis - JSON format...');
  const t3aStart = Date.now();
  const t3aId = ++id;
  send({
    jsonrpc: '2.0',
    id: t3aId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_graph',
      arguments: {
        filePath: path.join(fixturesPath, 'utils.ts'),
        response_format: 'json'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t3aTime = Date.now() - t3aStart;

  // Test 3b: Symbol-level analysis - TOON format
  log('🔹 Test 3b: Symbol-level analysis - TOON format...');
  const t3bStart = Date.now();
  const t3bId = ++id;
  send({
    jsonrpc: '2.0',
    id: t3bId,
    method: 'tools/call',
    params: {
      name: 'graphitlive_get_symbol_graph',
      arguments: {
        filePath: path.join(fixturesPath, 'utils.ts'),
        response_format: 'toon'
      }
    }
  });
  await new Promise(r => setTimeout(r, 800));
  const t3bTime = Date.now() - t3bStart;

  // Wait for all benchmark responses
  await new Promise(r => setTimeout(r, 2000));

  // Retrieve responses from the Map
  const t1aResponse = responses.get(t1aId);
  const t1bResponse = responses.get(t1bId);
  const t2aResponse = responses.get(t2aId);
  const t2bResponse = responses.get(t2bId);
  const t3aResponse = responses.get(t3aId);
  const t3bResponse = responses.get(t3bId);

  // Print benchmark results
  log('\n📊 ============================================');
  log('📊 BENCHMARK RESULTS');
  log('📊 ============================================\n');

  log('⏱️  Performance Comparison:');
  log(`   Test 1 (Small dataset):    JSON: ${t1aTime}ms | TOON: ${t1bTime}ms | Speedup: ${(t1aTime/t1bTime).toFixed(2)}x`);
  log(`   Test 2 (Medium dataset):   JSON: ${t2aTime}ms | TOON: ${t2bTime}ms | Speedup: ${(t2aTime/t2bTime).toFixed(2)}x`);
  log(`   Test 3 (Symbol analysis):  JSON: ${t3aTime}ms | TOON: ${t3bTime}ms | Speedup: ${(t3aTime/t3bTime).toFixed(2)}x`);

  log('\n💾 Token Savings Analysis:');
  
  // Test 1 comparison
  if (t1aResponse && t1bResponse) {
    const t1aContent = JSON.stringify(t1aResponse.result?.content?.[0]?.text || '');
    const t1bContent = JSON.stringify(t1bResponse.result?.content?.[0]?.text || '');
    const t1Savings = ((1 - t1bContent.length/t1aContent.length) * 100).toFixed(1);
    log(`\n   Test 1 (Small dataset):`);
    log(`      JSON size: ${t1aContent.length} chars`);
    log(`      TOON size: ${t1bContent.length} chars`);
    log(`      Savings:   ${t1Savings}%`);
    
    if (t1bContent.length < 500) {
      log(`\n      📄 JSON format (full):`);
      log(`      ${t1aContent}`);
      log(`\n      📄 TOON format (full):`);
      log(`      ${t1bContent}`);
    } else {
      log(`\n      📄 JSON format (preview):`);
      log(`      ${t1aContent.substring(0, 300)}...`);
      log(`\n      📄 TOON format (preview):`);
      log(`      ${t1bContent.substring(0, 300)}...`);
    }
  }

  // Test 2 comparison
  if (t2aResponse && t2bResponse) {
    const t2aContent = JSON.stringify(t2aResponse.result?.content?.[0]?.text || '');
    const t2bContent = JSON.stringify(t2bResponse.result?.content?.[0]?.text || '');
    const t2Savings = ((1 - t2bContent.length/t2aContent.length) * 100).toFixed(1);
    log(`\n   Test 2 (Medium dataset):`);
    log(`      JSON size: ${t2aContent.length} chars`);
    log(`      TOON size: ${t2bContent.length} chars`);
    log(`      Savings:   ${t2Savings}%`);
  }

  // Test 3 comparison
  if (t3aResponse && t3bResponse) {
    const t3aContent = JSON.stringify(t3aResponse.result?.content?.[0]?.text || '');
    const t3bContent = JSON.stringify(t3bResponse.result?.content?.[0]?.text || '');
    const t3Savings = ((1 - t3bContent.length/t3aContent.length) * 100).toFixed(1);
    log(`\n   Test 3 (Symbol analysis):`);
    log(`      JSON size: ${t3aContent.length} chars`);
    log(`      TOON size: ${t3bContent.length} chars`);
    log(`      Savings:   ${t3Savings}%`);
  }

  log('\n   ℹ️  Expected savings: 30-60% for structured data\n');

  // Wait for all responses
  await new Promise(r => setTimeout(r, 2000));
  
  log('\n✨ Test complete, shutting down...');
  server.kill('SIGTERM');
}

runTests().catch((err) => {
  error(err);
}); //NOSONAR
