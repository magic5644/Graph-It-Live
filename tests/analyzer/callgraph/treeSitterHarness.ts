import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileExtToLang, GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { normalizePath } from "@/shared/path";

const SQL_WASM = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");

/** `file#name` nodes and `file#name -RELATION@line-> file#name` edges (0-based lines) of an index. */
export function describeIndex(indexer: CallGraphIndexer, root: string) {
  const snapshot = indexer.getIndexSnapshot();
  const key = (id: string) => {
    const node = snapshot.nodes.find(n => n.id === id);
    return node ? `${path.relative(root, node.path).replaceAll("\\", "/")}#${node.name}` : id;
  };
  return {
    nodes: snapshot.nodes.map(n => ({ key: key(n.id), lang: n.lang, startLine: n.startLine, endLine: n.endLine })),
    edges: snapshot.edges.map(e => `${key(e.sourceId)} -${e.typeRelation}@${e.sourceLine}-> ${key(e.targetId)}`),
  };
}

/** Write `files` (relative path → source) under `root`. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([name, source]) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), source);
  }));
}

/** A fresh, initialized in-memory call graph index. */
async function newIndexer(): Promise<CallGraphIndexer> {
  const indexer = new CallGraphIndexer(SQL_WASM);
  await indexer.init();
  return indexer;
}

/** Grammars a harness loads: WASM file stem and query file stem (C# ships as `c_sharp`). */
const GRAMMARS = [["typescript", "typescript"], ["tsx", "tsx"], ["python", "python"], ["rust", "rust"], ["go", "go"], ["java", "java"], ["c_sharp", "csharp"]];

/**
 * A temporary workspace with every tree-sitter grammar, where `index(files)` writes the files and indexes
 * them in a fresh call graph, the way the MCP server does (extract, index, resolve cross-file edges).
 */
export async function createTreeSitterHarness(prefix: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const wasm = path.join(root, "dist/wasm");
  const queries = path.join(root, "dist/queries");
  await fs.mkdir(wasm, { recursive: true });
  await fs.mkdir(queries, { recursive: true });
  await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
  await Promise.all(GRAMMARS.flatMap(([grammar, query]) => [
    fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`, path.join(wasm, `tree-sitter-${grammar}.wasm`)),
    fs.copyFile(`resources/queries/${query}.scm`, path.join(queries, `${query}.scm`)),
  ]));
  const extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });

  /** Extract `files` into `indexer`; a file already indexed is replaced, as on an incremental update. */
  async function indexInto(indexer: CallGraphIndexer, files: Record<string, string>): Promise<void> {
    await writeFiles(root, files);
    // Extraction runs concurrently; indexing stays in file order, as on a workspace scan.
    const extracted = await Promise.all(Object.entries(files).map(async ([name, source]) => {
      const file = normalizePath(path.join(root, name));
      const lang = fileExtToLang(file);
      if (!lang) throw new Error(`No call graph language for ${name}`);
      return { file, lang, result: await extractor.extractSource(file, lang, source) };
    }));
    for (const { file, lang, result } of extracted) indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    indexer.resolveExternalEdges();
  }

  /** Index `files` in a fresh index and describe it; with `savePath`, also save the index there. */
  async function index(files: Record<string, string>, savePath?: string) {
    const indexer = await newIndexer();
    try {
      await indexInto(indexer, files);
      if (savePath) await indexer.saveToFile(savePath);
      return describeIndex(indexer, root);
    } finally {
      indexer.dispose();
    }
  }

  async function dispose(): Promise<void> {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }

  return { root, extractor, index, indexInto, newIndexer, describe: (indexer: CallGraphIndexer) => describeIndex(indexer, root), dispose };
}

export const SQL_WASM_PATH = SQL_WASM;
