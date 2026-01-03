#!/usr/bin/env node
/**
 * Simple demo of TOON format - shows JSON to TOON conversion
 */

const { jsonToToon, estimateTokenSavings } = require('../out/shared/toon');
const util = require('node:util');

function log(...args) {
  process.stdout.write(`${util.format(...args)}\n`);
}

log('🧪 TOON Format Demo\n');

// Example data: dependency graph
const data = [
  { file: 'main.ts', imports: ['fs', 'path', 'utils'], exports: ['main', 'run'] },
  { file: 'utils.ts', imports: ['os'], exports: ['helper1', 'helper2', 'helper3'] },
  { file: 'config.ts', imports: [], exports: ['config', 'settings', 'defaults'] },
  { file: 'types.ts', imports: [], exports: ['Type1', 'Type2', 'Interface1'] }
];

// Convert to JSON and TOON
const jsonStr = JSON.stringify(data, null, 2);
const toonStr = jsonToToon(data, { objectName: 'files' });

// Calculate savings
const savings = estimateTokenSavings(jsonStr, toonStr);

log('📄 Original JSON format:');
log('─'.repeat(60));
log(jsonStr);
log('─'.repeat(60));
log(`Size: ${jsonStr.length} characters (≈${savings.jsonTokens} tokens)\n`);

log('📄 TOON format:');
log('─'.repeat(60));
log(toonStr);
log('─'.repeat(60));
log(`Size: ${toonStr.length} characters (≈${savings.toonTokens} tokens)\n`);

log('📊 Savings Summary:');
log(`   • JSON size:   ${jsonStr.length} chars (${savings.jsonTokens} tokens)`);
log(`   • TOON size:   ${toonStr.length} chars (${savings.toonTokens} tokens)`);
log(`   • Saved:       ${savings.savings} tokens (${savings.savingsPercent.toFixed(1)}%)`);
log(`   • Reduction:   ${((1 - toonStr.length/jsonStr.length) * 100).toFixed(1)}% in size\n`);

log('✨ TOON Format Features:');
log('   • Removes JSON syntax overhead (quotes, braces)');
log('   • Uses compact header + data rows format');
log('   • Arrays joined with pipe | delimiter');
log('   • Ideal for large datasets with repeated structure');
log('   • Reduces token consumption for LLMs by 30-60%\n');
