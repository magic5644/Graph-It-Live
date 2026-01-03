#!/usr/bin/env node
/**
 * Test MCP Payload Limits
 * Verifies that the MCP server properly rejects oversized payloads
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const util = require('node:util');

function log(...args) {
  process.stdout.write(`${util.format(...args)}\n`);
}

function error(...args) {
  process.stderr.write(`${util.format(...args)}\n`);
}

const rootDir = path.resolve(__dirname, '..');
const serverPath = path.join(rootDir, 'dist/mcpServer.mjs');

log('🧪 Testing MCP Payload Limits\n');

const server = spawn('node', [serverPath], {
  env: {
    ...process.env,
    WORKSPACE_ROOT: path.join(rootDir, 'tests/fixtures/sample-project'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let responseId = 0;
const pendingTests = new Map();

/**
 * Extract error message from MCP response
 */
function getErrorMessage(response) {
  if (response.error) {
    return response.error.message;
  }
  
  if (response.result && response.result.content && response.result.content[0]) {
    return response.result.content[0].text;
  }
  
  return 'Unknown error';
}

/**
 * Check if response contains an error
 */
function hasResponseError(response) {
  return Boolean(response.error || (response.result && response.result.isError));
}

/**
 * Log test result (success or failure)
 */
function logTestResult(test, hasError, errorMessage) {
  if (test.expectError) {
    if (hasError) {
      log(`✅ ${test.name}: Correctly rejected`);
      // Extract validation error for display
      const match = errorMessage.match(/Input validation error: (.*)/);
      if (match) {
        log(`   Validation: ${match[1].substring(0, 100)}...\n`);
      } else {
        log(`   Error: ${errorMessage.substring(0, 100)}...\n`);
      }
    } else {
      log(`❌ ${test.name}: Should have been rejected but succeeded\n`);
    }
  } else if (hasError) {
    log(`❌ ${test.name}: Should succeed but got error`);
    log(`   Error: ${errorMessage.substring(0, 100)}...\n`);
  } else {
    log(`✅ ${test.name}: Correctly accepted\n`);
  }
}

/**
 * Handle parsed JSON-RPC response
 */
function handleResponse(response, pendingTests, server) {
  if (!response.id || !pendingTests.has(response.id)) {
    return false;
  }
  
  const test = pendingTests.get(response.id);
  pendingTests.delete(response.id);
  
  const hasError = hasResponseError(response);
  const errorMessage = getErrorMessage(response);
  
  logTestResult(test, hasError, errorMessage);
  
  // If all tests done, exit
  if (pendingTests.size === 0) {
    log('🎉 All payload limit tests completed');
    server.kill();
    process.exit(0);
  }
  
  return true;
}

// Parse JSON-RPC responses
const rl = readline.createInterface({ input: server.stdout });

rl.on('line', (line) => {
  if (!line.trim()) return;
  
  try {
    const response = JSON.parse(line);
    handleResponse(response, pendingTests, server);
  } catch (error) {
    // Intentionally ignore non-JSON lines (server logs, warmup messages, etc.)
    // Only JSON-RPC responses are relevant for this test script
    if (error instanceof SyntaxError) {
      // Expected: server may output non-JSON diagnostic messages to stdout
      return;
    }
    // Re-throw unexpected errors
    throw error;
  }
});

// Capture stderr
server.stderr.on('data', (data) => {
  const msg = data.toString();
  if (!msg.includes('PROCESS STARTING') && !msg.includes('warmup')) {
    error('Server stderr: %s', msg);
  }
});

server.on('close', (code) => {
  if (code !== 0 && pendingTests.size > 0) {
    error(`❌ Server exited with code ${code} before completing all tests`);
    process.exit(1);
  }
});

// Helper to send a tool call
function testToolCall(name, toolName, params, expectError = false) {
  responseId++;
  const id = responseId;
  
  pendingTests.set(id, { name, expectError });
  
  const request = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: `graphitlive_${toolName}`,
      arguments: params,
    },
  };
  
  server.stdin.write(JSON.stringify(request) + '\n');
}

// Wait for server to initialize
setTimeout(() => {
  log('Running payload limit tests...\n');
  
  // Test 1: Valid file path (should succeed)
  testToolCall(
    'Valid file path',
    'analyze_dependencies',
    {
      filePath: '/Users/test/project/src/index.ts',
    },
    false
  );
  
  // Test 2: Oversized file path (should fail)
  testToolCall(
    'Oversized file path (>1KB)',
    'analyze_dependencies',
    {
      filePath: '/path/' + 'a'.repeat(2000),
    },
    true
  );
  
  // Test 3: File path with null byte (should fail)
  testToolCall(
    'File path with null byte',
    'analyze_dependencies',
    {
      filePath: '/path/to/file\0.ts',
    },
    true
  );
  
  // Test 4: Valid symbol name (should succeed)
  testToolCall(
    'Valid symbol name',
    'get_symbol_callers',
    {
      filePath: '/Users/test/project/src/index.ts',
      symbolName: 'myFunction',
    },
    false
  );
  
  // Test 5: Oversized symbol name (should fail)
  testToolCall(
    'Oversized symbol name (>500 bytes)',
    'get_symbol_callers',
    {
      filePath: '/Users/test/project/src/index.ts',
      symbolName: 'a'.repeat(600),
    },
    true
  );
  
  // Test 6: Valid file content (should succeed)
  testToolCall(
    'Valid file content (~50KB)',
    'analyze_breaking_changes',
    {
      filePath: '/Users/test/project/src/api.ts',
      oldContent: 'export function test() {\n  return 42;\n}\n'.repeat(1000), // ~50KB
      newContent: 'export function test(x: number) {\n  return x * 2;\n}\n'.repeat(1000),
    },
    false
  );
  
  // Test 7: Oversized file content (should fail)
  testToolCall(
    'Oversized file content (>1MB)',
    'analyze_breaking_changes',
    {
      filePath: '/Users/test/project/src/api.ts',
      oldContent: 'x'.repeat(2 * 1024 * 1024), // 2 MB
    },
    true
  );
  
  // Test 8: File content with null byte (should fail)
  testToolCall(
    'File content with null byte',
    'analyze_breaking_changes',
    {
      filePath: '/Users/test/project/src/api.ts',
      oldContent: 'export const x = 1;\0',
    },
    true
  );
  
  // Test 9: Valid module specifier (should succeed)
  testToolCall(
    'Valid module specifier',
    'resolve_module_path',
    {
      fromFile: '/Users/test/project/src/index.ts',
      moduleSpecifier: './utils',
    },
    false
  );
  
  // Test 10: Oversized module specifier (should fail)
  testToolCall(
    'Oversized module specifier (>10KB)',
    'resolve_module_path',
    {
      fromFile: '/Users/test/project/src/index.ts',
      moduleSpecifier: '../'.repeat(5000), // ~15KB
    },
    true
  );
  
}, 2000); // Wait 2 seconds for initialization
