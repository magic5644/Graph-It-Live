#!/usr/bin/env node
/**
 * TOON Format Demo
 * 
 * This script demonstrates the usage of TOON format for reducing token consumption
 * in large structured datasets.
 */

import { jsonToToon, toonToJson, estimateTokenSavings } from '../src/shared/toon.js';
import util from 'node:util';

function log(...args) {
  process.stdout.write(`${util.format(...args)}\n`);
}

log('===== TOON Format Demonstration =====\n');

// Example 1: Simple file dependencies
log('Example 1: File Dependencies');
log('-----------------------------');

const fileDeps = [
  { file: 'main.ts', deps: ['fs', 'path', 'util'], line: 1 },
  { file: 'utils.ts', deps: ['os', 'crypto'], line: 10 },
  { file: 'config.ts', deps: ['dotenv'], line: 5 },
  { file: 'server.ts', deps: ['express', 'cors', 'helmet'], line: 20 },
  { file: 'db.ts', deps: ['mongoose', 'redis'], line: 15 },
];

const jsonStr = JSON.stringify(fileDeps, null, 2);
const toonStr = jsonToToon(fileDeps, { objectName: 'files' });

log('\nOriginal JSON:');
log(jsonStr);

log('\nTOON Format:');
log(toonStr);

const savings1 = estimateTokenSavings(jsonStr, toonStr);
log('\nToken Savings:');
log(`  JSON:    ${savings1.jsonTokens} tokens (${jsonStr.length} bytes)`);
log(`  TOON:    ${savings1.toonTokens} tokens (${toonStr.length} bytes)`);
log(`  Savings: ${savings1.savings} tokens (${savings1.savingsPercent.toFixed(1)}%)`);

// Verify round-trip
const restored = toonToJson(toonStr);
log('\nRound-trip verification:', JSON.stringify(restored) === JSON.stringify(fileDeps) ? '✅ PASS' : '❌ FAIL');

// Example 2: Symbol dependencies (larger dataset)
log('\n\nExample 2: Symbol Dependencies (Larger Dataset)');
log('------------------------------------------------');

const symbols = Array.from({ length: 50 }, (_, i) => ({
  symbol: `function${i}`,
  file: `module${Math.floor(i / 5)}.ts`,
  calls: [`helper${i % 10}`, `util${i % 15}`],
  line: (i + 1) * 10,
}));

const jsonStr2 = JSON.stringify(symbols, null, 2);
const toonStr2 = jsonToToon(symbols, { objectName: 'symbols' });

const savings2 = estimateTokenSavings(jsonStr2, toonStr2);

log('\nDataset size: 50 symbols');
log('\nToken Savings:');
log(`  JSON:    ${savings2.jsonTokens} tokens (${jsonStr2.length} bytes)`);
log(`  TOON:    ${savings2.toonTokens} tokens (${toonStr2.length} bytes)`);
log(`  Savings: ${savings2.savings} tokens (${savings2.savingsPercent.toFixed(1)}%)`);

log('\nTOON Preview (first 5 lines):');
const toonLines = toonStr2.split('\n').slice(0, 6);
log(toonLines.join('\n'));
log('...');

// Example 3: Edge cases
log('\n\nExample 3: Edge Cases');
log('---------------------');

const edgeCases = [
  { name: 'with,comma', tag: '[special]', value: 'pipe|char' },
  { name: 'empty', tag: '', value: null },
  { name: 'numbers', count: 42, price: 19.99 },
];

const toonEdge = jsonToToon(edgeCases, { objectName: 'items' });
log('\nOriginal:');
log(JSON.stringify(edgeCases, null, 2));

log('\nTOON (with escaping):');
log(toonEdge);

const restoredEdge = toonToJson(toonEdge);
log('\nRestored:');
log(JSON.stringify(restoredEdge, null, 2));

log('\nRound-trip verification:', JSON.stringify(restoredEdge) === JSON.stringify(edgeCases) ? '✅ PASS' : '❌ FAIL');

// Summary
log('\n\n===== Summary =====');
log('TOON format is ideal for:');
log('  ✓ Large datasets (>10 items)');
log('  ✓ Structured data with repeated fields');
log('  ✓ Token-sensitive LLM operations');
log('  ✓ Real-time dependency analysis');
log('\nAverage token savings: 30-60%');
log('Best use case: MCP tool responses with arrays of objects\n');
