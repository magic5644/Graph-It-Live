#!/usr/bin/env node
/**
 * MCP Server Test Script
 * Tests all MCP server tools with real tool calls and auto-terminates
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const rootDir = path.resolve(__dirname, '..');
const serverPath = path.join(rootDir, 'dist/mcpServer.mjs');
const fixturesPath = path.join(rootDir, 'tests/fixtures/sample-project/src');

console.log('🚀 Starting MCP Server Test\n');
console.log('Server:', serverPath);
console.log('Fixtures:', fixturesPath);
console.log('');

const server = spawn('node', [serverPath], {
  env: {
    ...process.env,
    WORKSPACE_ROOT: path.join(rootDir, 'tests/fixtures/sample-project'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let responseCount = 0;
let expectedResponses = 0;
const responses = new Map();

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
      console.log(`✅ Response ${response.id}:`, truncated);
    }
  } catch (e) {
    // Not JSON, ignore
  }
});

// Log stderr (server logs)
server.stderr.on('data', (data) => {
  const lines = data.toString().trim().split('\n');
  for (const line of lines) {
    if (line.includes('Worker ready') || line.includes('Warmup complete')) {
      console.log('🔥', line);
    } else if (line.includes('ERROR') || line.includes('error')) {
      console.log('❌', line);
    }
  }
});

server.on('close', (code) => {
  console.log(`\n📊 Test Summary:`);
  console.log(`   Expected responses: ${expectedResponses}`);
  console.log(`   Responses received: ${responseCount}`);
  console.log(`   Exit code: ${code}`);
  
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
  console.log('📤 Sending initialize...');
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
  console.log('⏳ Waiting 3s for warmup...');
  await new Promise(r => setTimeout(r, 3000));

  // =========================================================================
  // 2. get_index_status - Verify index is ready
  // =========================================================================
  console.log('\n📤 [get_index_status] Getting index status...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'get_index_status',
      arguments: {}
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 3. analyze_dependencies - Analyze a single file
  // =========================================================================
  console.log('\n📤 [analyze_dependencies] Analyzing main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'analyze_dependencies',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 4. parse_imports - Parse imports without resolution
  // =========================================================================
  console.log('\n📤 [parse_imports] Parsing imports from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'parse_imports',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 5. resolve_module_path - Resolve a relative import
  // =========================================================================
  console.log('\n📤 [resolve_module_path] Resolving "./utils" from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'resolve_module_path',
      arguments: {
        fromFile: path.join(fixturesPath, 'main.ts'),
        moduleSpecifier: './utils'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 6. resolve_module_path - Resolve a path alias (should fail gracefully)
  // =========================================================================
  console.log('\n📤 [resolve_module_path] Resolving "@components/Button" from main.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'resolve_module_path',
      arguments: {
        fromFile: path.join(fixturesPath, 'main.ts'),
        moduleSpecifier: '@components/Button'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 7. crawl_dependency_graph - Build full dependency graph
  // =========================================================================
  console.log('\n📤 [crawl_dependency_graph] Crawling from main.ts (maxDepth=3)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 3
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 8. crawl_dependency_graph - Test pagination
  // =========================================================================
  console.log('\n📤 [crawl_dependency_graph] Crawling with pagination (limit=1, offset=0)...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'crawl_dependency_graph',
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
  // 9. find_referencing_files - Find files that import utils.ts
  // =========================================================================
  console.log('\n📤 [find_referencing_files] Finding files that reference utils.ts...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'find_referencing_files',
      arguments: {
        targetPath: path.join(fixturesPath, 'utils.ts')
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 10. expand_node - Expand from a node with known paths
  // =========================================================================
  console.log('\n📤 [expand_node] Expanding main.ts excluding known paths...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'expand_node',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts'),
        knownPaths: [path.join(fixturesPath, 'main.ts')],
        extraDepth: 5
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // 11. Error case: analyze_dependencies with non-existent file
  // =========================================================================
  console.log('\n📤 [analyze_dependencies] Testing error case: non-existent file...');
  send({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'analyze_dependencies',
      arguments: {
        filePath: '/non/existent/file.ts'
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Wait for all responses
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('\n✨ Test complete, shutting down...');
  server.kill('SIGTERM');
}

runTests().catch(console.error);
