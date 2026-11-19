// Rewrites contributes.languageModelTools[] in package.json from the MCP sources: modelDescription
// from src/mcp/toolDescriptions.ts, and the inputSchema of every LM tool with an MCP twin from the
// same Zod schema the MCP server validates with (src/mcp/types.ts), plus the shared response_format.
// Run with --check to fail on drift instead.
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const packagePath = 'package.json';
const lmPrefix = 'graph-it-live_';

const bundle = await build({
  stdin: {
    contents: [
      "export { lmToolDescription, LM_RESPONSE_FORMAT_PROPERTY } from './src/mcp/toolDescriptions';",
      "export { toolSchemas } from './src/mcp/types';",
      "export { z } from 'zod/v4';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'error',
});
const { lmToolDescription, LM_RESPONSE_FORMAT_PROPERTY, toolSchemas, z } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

/** The LM input schema of a tool with an MCP twin: the MCP parameters, nothing else. */
function inputSchemaFromZod(schema) {
  const { properties = {}, required } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return {
    type: 'object',
    properties: { ...properties, response_format: LM_RESPONSE_FORMAT_PROPERTY },
    ...(required?.length ? { required } : {}),
    additionalProperties: false,
  };
}

const source = await readFile(packagePath, 'utf8');
const manifest = JSON.parse(source);
for (const tool of manifest.contributes.languageModelTools) {
  const name = tool.name.slice(lmPrefix.length);
  const schema = toolSchemas[name];
  if (schema) {
    tool.inputSchema = inputSchemaFromZod(schema);
  } else {
    tool.inputSchema.properties.response_format = LM_RESPONSE_FORMAT_PROPERTY;
  }
  tool.modelDescription = lmToolDescription(name, Object.keys(tool.inputSchema.properties));
}
const updated = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (updated !== source) {
    console.error('package.json languageModelTools (modelDescription or inputSchema) is out of date. Run: npm run sync:tool-descriptions');
    process.exit(1);
  }
} else if (updated !== source) {
  await writeFile(packagePath, updated);
  console.log('Updated package.json languageModelTools modelDescription and inputSchema fields.');
}
