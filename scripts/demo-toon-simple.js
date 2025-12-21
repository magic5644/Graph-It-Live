#!/usr/bin/env node
/**
 * Simple demo of TOON format - shows JSON to TOON conversion
 */

const { jsonToToon, estimateTokenSavings } = require('../out/shared/toon');

console.log('🧪 TOON Format Demo\n');

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

console.log('📄 Original JSON format:');
console.log('─'.repeat(60));
console.log(jsonStr);
console.log('─'.repeat(60));
console.log(`Size: ${jsonStr.length} characters (≈${savings.jsonTokens} tokens)\n`);

console.log('📄 TOON format:');
console.log('─'.repeat(60));
console.log(toonStr);
console.log('─'.repeat(60));
console.log(`Size: ${toonStr.length} characters (≈${savings.toonTokens} tokens)\n`);

console.log('📊 Savings Summary:');
console.log(`   • JSON size:   ${jsonStr.length} chars (${savings.jsonTokens} tokens)`);
console.log(`   • TOON size:   ${toonStr.length} chars (${savings.toonTokens} tokens)`);
console.log(`   • Saved:       ${savings.savings} tokens (${savings.savingsPercent.toFixed(1)}%)`);
console.log(`   • Reduction:   ${((1 - toonStr.length/jsonStr.length) * 100).toFixed(1)}% in size\n`);

console.log('✨ TOON Format Features:');
console.log('   • Removes JSON syntax overhead (quotes, braces)');
console.log('   • Uses compact header + data rows format');
console.log('   • Arrays joined with pipe | delimiter');
console.log('   • Ideal for large datasets with repeated structure');
console.log('   • Reduces token consumption for LLMs by 30-60%\n');
