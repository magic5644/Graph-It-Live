#!/usr/bin/env node
/**
 * MCP Server Test Script
 * Tests the MCP server with real tool calls and auto-terminates
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

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
  console.log(`   Responses received: ${responseCount}`);
  console.log(`   Exit code: ${code}`);
  process.exit(code || 0);
});

// Send a message
function send(msg) {
  server.stdin.write(JSON.stringify(msg) + '\n');
}

// Test sequence
async function runTests() {
  // 1. Initialize
  console.log('📤 Sending initialize...');
  send({
    jsonrpc: '2.0',
    id: 1,
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

  // 2. Get index status
  console.log('📤 Sending get_index_status...');
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_index_status',
      arguments: {}
    }
  });

  await new Promise(r => setTimeout(r, 500));

  // 3. Analyze dependencies
  console.log('📤 Sending analyze_dependencies...');
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'analyze_dependencies',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });

  await new Promise(r => setTimeout(r, 500));

  // 4. Parse imports
  console.log('📤 Sending parse_imports...');
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'parse_imports',
      arguments: {
        filePath: path.join(fixturesPath, 'main.ts')
      }
    }
  });

  await new Promise(r => setTimeout(r, 500));

  // 5. Crawl dependency graph
  console.log('📤 Sending crawl_dependency_graph...');
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'crawl_dependency_graph',
      arguments: {
        entryFile: path.join(fixturesPath, 'main.ts'),
        maxDepth: 3
      }
    }
  });

  // Wait for all responses
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('\n✨ Test complete, shutting down...');
  server.kill('SIGTERM');
}

runTests().catch(console.error);
