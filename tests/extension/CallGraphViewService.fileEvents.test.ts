import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: { workspaceFolders: undefined },
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
  indexWorkspacePromise: Promise<void> | null;
  indexWorkspace(root: string, indexer: CallGraphIndexer, extractor: GraphExtractor, skipPath?: string, silent?: boolean): Promise<void>;
  ensureExtractor(root: string): GraphExtractor;
  dropIndex(): Promise<void>;
};

const PAGE = "import { Card } from './Card';\nexport function Page() { return <Card />; }\n";
const CARD = "export function Card() { return <section />; }\n";

describe("CallGraphViewService applies file events after its workspace pass (#591)", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-events-");
  });
  afterAll(() => harness.dispose());

  /** A service whose workspace pass already indexed Page.tsx only. */
  async function indexedService() {
    const indexer = await harness.newIndexer();
    await harness.indexInto(indexer, { "src/Page.tsx": PAGE });
    const page = path.join(harness.root, "src/Page.tsx");
    const importers = async (file: string) => {
      if (file.endsWith("Broken.tsx")) throw new Error("no reverse index");
      return [card(), normalizePath(path.join(harness.root, "src/Tile.tsx"))].includes(normalizePath(file)) ? [page] : [];
    };
    const service = new CallGraphViewService({ subscriptions: [], extensionPath: harness.root } as never, importers);
    const internals = service as unknown as Internals;
    internals.indexer = indexer;
    internals.workspaceIndexedRoot = normalizePath(harness.root);
    const show = async () => {
      await internals.indexWorkspace(normalizePath(harness.root), indexer, internals.ensureExtractor(harness.root));
      indexer.resolveExternalEdges();
      return harness.describe(indexer).edges.filter((e) => !e.includes("@@external"));
    };
    return { service, internals, indexer, show };
  }
  const card = () => normalizePath(path.join(harness.root, "src/Card.tsx"));
  const changed = (service: CallGraphViewService) => [...(service as unknown as { changedFiles: Map<string, string> }).changedFiles];

  it("indexes a file created after the pass on the next show, and drops it once deleted", async () => {
    const { service, indexer, show } = await indexedService();
    try {
      await fs.writeFile(card(), CARD);
      expect(await show()).toEqual([]);

      service.markFileChanged(card(), "create");
      expect(await show()).toEqual(["src/Page.tsx#Page -REFERENCES@1-> src/Card.tsx#Card"]);

      await fs.rm(card());
      service.markFileChanged(card(), "delete");
      expect(await show()).toEqual([]);
    } finally {
      indexer.dispose();
    }
  });

  it("re-extracts a file changed on disk outside the editor", async () => {
    const { service, indexer, show } = await indexedService();
    try {
      await fs.writeFile(card(), CARD);
      service.markFileChanged(card(), "create");
      await show();

      await fs.writeFile(card(), "export function Board() { return <section />; }\n");
      service.markFileChanged(card(), "change");
      expect(await show()).toEqual([]);
    } finally {
      indexer.dispose();
    }
  });

  it("ignores events before any pass, keeps those during a pass, and forgets them when the index is dropped", async () => {
    const { service, internals, indexer } = await indexedService();
    const changedPaths = () => changed(service).map(([file]) => file);
    try {
      internals.workspaceIndexedRoot = null;
      service.markFileChanged(card(), "create");
      expect(changedPaths()).toEqual([]);

      internals.indexWorkspacePromise = Promise.resolve();
      service.markFileChanged(`${harness.root}${path.sep}src${path.sep}Card.tsx`, "change");
      expect(changedPaths()).toEqual([card()]);

      internals.indexWorkspacePromise = null;
      internals.indexer = null;
      await internals.dropIndex();
      expect(changedPaths()).toEqual([]);
    } finally {
      indexer.dispose();
    }
  });

  it("notes only call graph sources inside the indexed root", async () => {
    const { service, indexer } = await indexedService();
    try {
      for (const file of ["src/README.md", "src/data.json", "../outside/Card.tsx"]) service.markFileChanged(path.join(harness.root, file), "change");
      service.markFileChanged(card(), "change");

      expect(changed(service)).toEqual([[card(), "change"]]);
    } finally {
      indexer.dispose();
    }
  });

  it("relinks the importer when a component file is renamed (delete then create)", async () => {
    const { service, indexer, show } = await indexedService();
    const tile = normalizePath(path.join(harness.root, "src/Tile.tsx"));
    try {
      await fs.writeFile(card(), CARD);
      service.markFileChanged(card(), "create");
      expect(await show()).toEqual(["src/Page.tsx#Page -REFERENCES@1-> src/Card.tsx#Card"]);

      await fs.rename(card(), tile);
      await fs.writeFile(path.join(harness.root, "src/Page.tsx"), PAGE.replace("'./Card'", "'./Tile'"));
      service.markFileChanged(card(), "delete");
      service.markFileChanged(tile, "create");
      expect(await show()).toEqual(["src/Page.tsx#Page -REFERENCES@1-> src/Tile.tsx#Card"]);
    } finally {
      await fs.writeFile(path.join(harness.root, "src/Page.tsx"), PAGE);
      await fs.rm(tile, { force: true });
      indexer.dispose();
    }
  });

  it("skips the active file, a file that cannot be read and a failing importer lookup, and keeps the rest", async () => {
    const { service, internals, indexer } = await indexedService();
    const broken = normalizePath(path.join(harness.root, "src/Broken.tsx"));
    const gone = normalizePath(path.join(harness.root, "src/Gone.tsx"));
    try {
      await fs.writeFile(card(), CARD);
      await fs.writeFile(broken, "export function Broken() { return <i />; }\n");
      for (const file of [card(), broken, gone]) service.markFileChanged(file, "change");

      await internals.indexWorkspace(normalizePath(harness.root), indexer, internals.ensureExtractor(harness.root), card());

      const files = harness.describe(indexer).nodes.map((n) => n.key.split("#")[0]);
      expect(files).toContain("src/Broken.tsx");
      expect(files).not.toContain("src/Card.tsx");
      expect(files).not.toContain("src/Gone.tsx");
      expect(changed(service)).toEqual([]);
    } finally {
      await fs.rm(card(), { force: true });
      await fs.rm(broken, { force: true });
      indexer.dispose();
    }
  });

  it("applies the events once when two shows overlap, and returns at once when there is nothing new", async () => {
    const { service, internals, indexer } = await indexedService();
    const extractor = internals.ensureExtractor(harness.root);
    const extractFile = vi.spyOn(extractor, "extractFile");
    try {
      await fs.writeFile(card(), CARD);
      service.markFileChanged(card(), "create");
      const root = normalizePath(harness.root);

      await Promise.all([internals.indexWorkspace(root, indexer, extractor), internals.indexWorkspace(root, indexer, extractor)]);
      // Card.tsx once, then its importer Page.tsx once.
      expect(extractFile.mock.calls.map(([file]) => path.basename(file))).toEqual(["Card.tsx", "Page.tsx"]);

      await internals.indexWorkspace(root, indexer, extractor);
      expect(extractFile).toHaveBeenCalledTimes(2);
      expect(internals.indexWorkspacePromise).toBeNull();
    } finally {
      await fs.rm(card(), { force: true });
      indexer.dispose();
    }
  });
});
