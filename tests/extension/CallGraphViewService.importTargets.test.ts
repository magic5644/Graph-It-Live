import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const editor = vi.hoisted(() => ({ current: undefined as unknown, root: "" }));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
    get activeTextEditor() { return editor.current; },
    showInformationMessage: vi.fn(),
  },
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: editor.root } }]; },
    onDidSaveTextDocument: () => ({ dispose: vi.fn() }),
  },
  commands: { executeCommand: vi.fn() },
}));

import type { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import type { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphViewService } from "@/extension/services/CallGraphViewService";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness } from "../analyzer/callgraph/treeSitterHarness";

type Internals = {
  indexer: CallGraphIndexer | null;
  workspaceIndexedRoot: string | null;
  ensureExtractor(root: string): GraphExtractor;
  indexImportTargets(edges: Array<{ targetId: string }>, root: string, indexer: CallGraphIndexer, extractor: GraphExtractor): Promise<void>;
};

const PAGE = "import { Card } from './Card';\nexport function Page() { return <Card />; }\n";
const CARD = "export function Card() { return <section />; }\n";
const LINKED = ["src/Page.tsx#Page -REFERENCES@1-> src/Card.tsx#Card"];

describe("CallGraphViewService.show() indexes the active file's import targets without a watcher event (#600)", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  const file = (name: string) => normalizePath(path.join(harness.root, name));

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-imports-");
    editor.root = harness.root;
  });
  afterAll(() => harness.dispose());

  /** A service whose workspace pass is done and which never received a file event for Card.tsx. */
  async function passedService(indexed: Record<string, string>) {
    const indexer = await harness.newIndexer();
    await harness.indexInto(indexer, { "src/Page.tsx": PAGE, ...indexed });
    const service = new CallGraphViewService({ subscriptions: [], extensionPath: harness.root } as never);
    const internals = service as unknown as Internals;
    internals.indexer = indexer;
    internals.workspaceIndexedRoot = normalizePath(harness.root);
    const extractor = internals.ensureExtractor(normalizePath(harness.root));
    const extracted = vi.spyOn(extractor, "extractFile");
    // Cursor on Page, the active file.
    editor.current = {
      document: { uri: { fsPath: path.join(harness.root, "src", "Page.tsx") }, languageId: "typescriptreact" },
      selection: { active: { line: 1 } },
    };
    const edges = () => harness.describe(indexer).edges.filter((e) => !e.includes("@@external"));
    const extractedFiles = () => extracted.mock.calls.map(([f]) => normalizePath(f));
    return { service, internals, indexer, extractor, edges, extractedFiles };
  }

  it("indexes a target with no record", async () => {
    await fs.rm(file("src/Card.tsx"), { force: true });
    const { service, indexer, edges, extractedFiles } = await passedService({});
    try {
      await fs.writeFile(file("src/Card.tsx"), CARD);
      await service.show();
      expect(edges()).toEqual(LINKED);
      expect(extractedFiles()).toEqual([file("src/Page.tsx"), file("src/Card.tsx")]);
    } finally {
      indexer.dispose();
    }
  });

  it("re-extracts a target older than the file on disk", async () => {
    // The record says Card.tsx declares Board (mtime 1); the disk now declares Card.
    const { service, indexer, edges } = await passedService({ "src/Card.tsx": "export function Board() { return <section />; }\n" });
    try {
      await fs.writeFile(file("src/Card.tsx"), CARD);
      await service.show();
      expect(edges()).toEqual(LINKED);
    } finally {
      indexer.dispose();
    }
  });

  it("does not re-extract a fresh target, and a second show() extracts only the active file", async () => {
    const { service, indexer, edges, extractedFiles } = await passedService({});
    try {
      await fs.writeFile(file("src/Card.tsx"), CARD);
      await service.show();
      await service.show();
      expect(edges()).toEqual(LINKED);
      expect(extractedFiles()).toEqual([file("src/Page.tsx"), file("src/Card.tsx"), file("src/Page.tsx")]);
    } finally {
      indexer.dispose();
    }
  });

  it("leaves a deleted target out", async () => {
    const { service, indexer, edges, extractedFiles } = await passedService({});
    try {
      await fs.rm(file("src/Card.tsx"), { force: true });
      await service.show();
      expect(edges()).toEqual([]);
      expect(extractedFiles()).toEqual([file("src/Page.tsx")]);
    } finally {
      indexer.dispose();
    }
  });

  it("skips targets outside the root, in an unsupported language, or not imported, and accepts Windows separators", async () => {
    const { internals, indexer, extractor, extractedFiles } = await passedService({});
    const stub = (target: string) => `@@import:${JSON.stringify([target, "Card"])}`;
    const outside = path.join(path.dirname(harness.root), "outside", "Card.tsx");
    try {
      await fs.writeFile(file("src/Card.tsx"), CARD);
      await fs.writeFile(file("src/data.json"), "{}");
      await internals.indexImportTargets([
        { targetId: stub(outside) },
        { targetId: stub(`${harness.root}-sibling/Card.tsx`) },
        { targetId: stub(file("src/data.json")) },
        { targetId: `@@external:${file("src/Card.tsx")}` },
        { targetId: stub(file("src/Card.tsx").replaceAll("/", "\\")) },
      ], normalizePath(harness.root), indexer, extractor);
      expect(extractedFiles()).toEqual([file("src/Card.tsx")]);

      await internals.indexImportTargets([{ targetId: "@@external:Card" }], normalizePath(harness.root), indexer, extractor);
      expect(extractedFiles()).toHaveLength(1);
    } finally {
      indexer.dispose();
    }
  });

  it("shares one module read cache across the files of a bulk pass, never across passes", async () => {
    const { internals, indexer, extractor, edges } = await passedService({ "src/Card.tsx": CARD });
    try {
      const bulk = (internals as unknown as {
        extractAndIndexBatches(jobs: Array<{ filePath: string; lang: "typescript"; mtime: number }>, indexer: CallGraphIndexer,
          extractor: GraphExtractor, progress: { done: number; total: number }): Promise<void>;
      }).extractAndIndexBatches.bind(internals);
      const extracted = vi.mocked(extractor.extractFile);
      extracted.mockClear();
      const jobs = [file("src/Page.tsx"), file("src/Card.tsx")].map((filePath) => ({ filePath, lang: "typescript" as const, mtime: 2 }));
      await bulk(jobs, indexer, extractor, { done: 0, total: 2 });
      await bulk(jobs, indexer, extractor, { done: 0, total: 2 });
      const reads = extracted.mock.calls.map((call) => call[3]);
      expect(reads[0]).toBeInstanceOf(Map);
      expect(reads[1]).toBe(reads[0]);
      expect(reads[2]).not.toBe(reads[0]);
      expect(reads[3]).toBe(reads[2]);
      indexer.resolveExternalEdges();
      expect(edges()).toEqual(LINKED);
    } finally { indexer.dispose(); }
  });
});
