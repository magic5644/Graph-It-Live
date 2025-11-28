const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // Build Extension (Node.js)
  const ctxExtension = await esbuild.context({
    entryPoints: ['src/extension/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'node18',
  });

  // Build Indexer Worker (Node.js Worker Thread)
  // This runs in a separate thread for CPU-intensive indexing
  const ctxWorker = await esbuild.context({
    entryPoints: ['src/analyzer/IndexerWorker.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/indexerWorker.js',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'node18',
  });

  // Build MCP Server (Node.js Stdio Process)
  // This is the entry point spawned by VS Code for MCP communication
  // Uses ESM format to support @modelcontextprotocol/sdk which is ESM-only
  const ctxMcpServer = await esbuild.context({
    entryPoints: ['src/mcp/mcpServer.ts'],
    bundle: true,
    format: 'esm',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/mcpServer.mjs',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'node18',
    banner: {
      // Required for ESM to have __dirname and __filename
      js: `import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`,
    },
  });

  // Build MCP Worker (Node.js Worker Thread)
  // This runs in a separate thread for CPU-intensive MCP operations
  const ctxMcpWorker = await esbuild.context({
    entryPoints: ['src/mcp/McpWorker.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/mcpWorker.js',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'node18',
  });

  // Build Webview (Browser)
  const ctxWebview = await esbuild.context({
    entryPoints: ['src/webview/index.tsx'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'dist/webview.js',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'es2022',
    loader: {
      '.css': 'text',
    },
  });

  if (watch) {
    await ctxExtension.watch();
    await ctxWorker.watch();
    await ctxMcpServer.watch();
    await ctxMcpWorker.watch();
    await ctxWebview.watch();
  } else {
    await ctxExtension.rebuild();
    await ctxWorker.rebuild();
    await ctxMcpServer.rebuild();
    await ctxMcpWorker.rebuild();
    await ctxWebview.rebuild();
    await ctxExtension.dispose();
    await ctxWorker.dispose();
    await ctxMcpServer.dispose();
    await ctxMcpWorker.dispose();
    await ctxWebview.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
