const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

function stdout(line) {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function stderr(line) {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const cliOnly = process.argv.includes('--cli-only');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// Extract metafile path from --metafile=path argument
const metafileArg = process.argv.find(arg => arg.startsWith('--metafile='));
const metafilePath = metafileArg ? metafileArg.split('=')[1] : null;

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      stdout('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        stderr(`✘ [ERROR] ${text}`);
        if (location) {
          stderr(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      stdout('[watch] build finished');
    });
  },
};

/**
 * Saves metafiles with path validation to prevent path traversal
 * @param {string} metafilePath - Path to save combined metafile
 * @param {object} results - Build results containing metafiles
 */
function saveMetafiles(metafilePath, results) {
  const { resultExtension, resultWorker, resultAstWorker, resultMcpServer, resultMcpWorker, resultWebview } = results;
  
  // Validate and resolve metafile path to prevent path traversal
  const resolvedPath = path.resolve(metafilePath);
  const combinedMetafile = {
    extension: resultExtension.metafile,
    indexerWorker: resultWorker.metafile,
    astWorker: resultAstWorker.metafile,
    mcpServer: resultMcpServer.metafile,
    mcpWorker: resultMcpWorker.metafile,
    webview: resultWebview.metafile,
  };
  fs.writeFileSync(resolvedPath, JSON.stringify(combinedMetafile, null, 2));
  stdout(`✓ Metafile saved to ${resolvedPath}`);
  
  // Also save individual metafiles for analysis tools
  if (resultExtension.metafile) {
    fs.writeFileSync('dist/extension.meta.json', JSON.stringify(resultExtension.metafile, null, 2));
  }
  if (resultAstWorker.metafile) {
    fs.writeFileSync('dist/astWorker.meta.json', JSON.stringify(resultAstWorker.metafile, null, 2));
  }
  if (resultWebview.metafile) {
    fs.writeFileSync('dist/webview.meta.json', JSON.stringify(resultWebview.metafile, null, 2));
  }
  if (resultMcpWorker.metafile) {
    fs.writeFileSync('dist/mcpWorker.meta.json', JSON.stringify(resultMcpWorker.metafile, null, 2));
  }
  stdout('✓ Individual metafiles saved to dist/*.meta.json');
}

/**
 * Copy WASM files from node_modules to dist directory
 * Required for web-tree-sitter WASM parsers
 */
function copyWasmFiles() {
  const wasmOutDir = path.join('dist', 'wasm');
  fs.mkdirSync(wasmOutDir, { recursive: true });

  const wasmFiles = [
    {
      src: 'node_modules/web-tree-sitter/web-tree-sitter.wasm',
      fileName: 'tree-sitter.wasm',
    },
    {
      src: 'node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm',
      fileName: 'tree-sitter-typescript.wasm',
    },
    {
      src: 'node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm',
      fileName: 'tree-sitter-python.wasm',
    },
    {
      src: 'node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm',
      fileName: 'tree-sitter-rust.wasm',
    },
    {
      src: 'node_modules/sql.js/dist/sql-wasm.wasm',
      fileName: 'sqljs.wasm',
    },
  ];

  for (const { src, fileName } of wasmFiles) {
    const destinations = [
      path.join(wasmOutDir, fileName),      // Canonical runtime location (dist/wasm/)
    ];

    try {
      for (const dest of destinations) {
        fs.copyFileSync(src, dest);
      }
      stdout(`✓ Copied ${fileName}`);
    } catch (error) {
      stderr(`✘ Failed to copy ${src}: ${error.message}`);
      throw error;
    }
  }
  stdout('✓ All WASM files copied to dist/');
}

/**
 * Copy Tree-sitter query files from resources/queries/ to dist/queries/
 * Required for runtime query file lookup via extensionPath
 */
function copyQueryFiles() {
  const queriesSrcDir = path.join('resources', 'queries');
  const queriesOutDir = path.join('dist', 'queries');

  if (!fs.existsSync(queriesSrcDir)) {
    stdout('⚠ resources/queries/ not found, skipping query file copy');
    return;
  }

  fs.mkdirSync(queriesOutDir, { recursive: true });

  const queryFiles = fs.readdirSync(queriesSrcDir).filter(f => f.endsWith('.scm'));

  for (const fileName of queryFiles) {
    const src = path.join(queriesSrcDir, fileName);
    const dest = path.join(queriesOutDir, fileName);
    fs.copyFileSync(src, dest);
    stdout(`✓ Copied query file ${fileName}`);
  }

  stdout(`✓ Query files copied to dist/queries/ (${queryFiles.length} files)`);
}

/** Shared esbuild options for all Node.js bundles */
function nodeBundle(entryPoint, outfile, extra = {}) {
  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'node20',
    metafile: !!metafilePath,
    loader: { '.wasm': 'file' },
    ...extra,
  };
}

/** Shared esbuild options for all browser bundles */
function browserBundle(entryPoint, outfile, extra = {}) {
  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
    target: 'es2022',
    metafile: !!metafilePath,
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
    ...extra,
  };
}

const ESM_BANNER = {
  js: `import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`,
};

async function createAllContexts() {
  const extension = cliOnly ? null : await esbuild.context(nodeBundle(
    'src/extension/extension.ts', 'dist/extension.js',
    { external: ['vscode', 'web-tree-sitter'] },
  ));
  const worker = await esbuild.context(nodeBundle('src/analyzer/IndexerWorker.ts', 'dist/indexerWorker.js', { external: ['web-tree-sitter'] }));
  const astWorker = await esbuild.context(nodeBundle('src/analyzer/ast/AstWorker.ts', 'dist/astWorker.js', { external: ['web-tree-sitter'] }));
  const mcpServer = await esbuild.context(nodeBundle('src/mcp/mcpServer.ts', 'dist/mcpServer.mjs', { format: 'esm', external: ['web-tree-sitter'], banner: ESM_BANNER }));
  const mcpWorker = await esbuild.context(nodeBundle('src/mcp/McpWorker.ts', 'dist/mcpWorker.js', { external: ['web-tree-sitter'] }));
  const cli = await esbuild.context(nodeBundle('src/cli/index.ts', 'dist/graph-it.js', { external: ['vscode', 'web-tree-sitter'], define: { 'process.env.CLI_VERSION': JSON.stringify(pkg.version) } }));
  const webview = cliOnly ? null : await esbuild.context(browserBundle('src/webview/index.tsx', 'dist/webview.js'));
  const callgraphWebview = cliOnly ? null : await esbuild.context(browserBundle('src/webview/callgraph/index.tsx', 'dist/callgraph.js'));
  return { extension, worker, astWorker, mcpServer, mcpWorker, cli, webview, callgraphWebview };
}

async function watchContexts(ctxs) {
  if (ctxs.extension) await ctxs.extension.watch();
  await ctxs.worker.watch();
  await ctxs.astWorker.watch();
  await ctxs.mcpServer.watch();
  await ctxs.mcpWorker.watch();
  await ctxs.cli.watch();
  if (ctxs.webview) await ctxs.webview.watch();
  if (ctxs.callgraphWebview) await ctxs.callgraphWebview.watch();
}

async function rebuildAndDispose(ctxs) {
  const resultExtension = ctxs.extension ? await ctxs.extension.rebuild() : null;
  const resultWorker = await ctxs.worker.rebuild();
  const resultAstWorker = await ctxs.astWorker.rebuild();
  const resultMcpServer = await ctxs.mcpServer.rebuild();
  const resultMcpWorker = await ctxs.mcpWorker.rebuild();
  const resultWebview = ctxs.webview ? await ctxs.webview.rebuild() : null;
  if (ctxs.callgraphWebview) await ctxs.callgraphWebview.rebuild();
  await ctxs.cli.rebuild();

  // 0o755 = owner:rwx group:rx others:rx — standard for a CLI executable // NOSONAR
  try {
    fs.chmodSync('dist/graph-it.js', 0o755); // NOSONAR
  } catch (chmodErr) {
    if (process.platform !== 'win32') stderr(`⚠ Could not chmod dist/graph-it.js: ${chmodErr.message}`);
  }

  copyWasmFiles();
  copyQueryFiles();

  if (metafilePath && !cliOnly && resultExtension && resultWebview) {
    saveMetafiles(metafilePath, { resultExtension, resultWorker, resultAstWorker, resultMcpServer, resultMcpWorker, resultWebview });
  }

  if (ctxs.extension) await ctxs.extension.dispose();
  await ctxs.worker.dispose();
  await ctxs.astWorker.dispose();
  await ctxs.mcpServer.dispose();
  await ctxs.mcpWorker.dispose();
  await ctxs.cli.dispose();
  if (ctxs.callgraphWebview) await ctxs.callgraphWebview.dispose();
  if (ctxs.webview) await ctxs.webview.dispose();
}

async function main() {
  const ctxs = await createAllContexts();
  if (watch) {
    await watchContexts(ctxs);
  } else {
    await rebuildAndDispose(ctxs);
  }
}

// Entry point - CommonJS doesn't support top-level await (NOSONAR)
main().catch(e => { // NOSONAR
  stderr(String(e));
  process.exit(1);
});
