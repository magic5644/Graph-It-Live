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
import { CallGraphViewService } from "@/extension/services/CallGraphViewService";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness } from "../analyzer/callgraph/treeSitterHarness";

type Internals = {
  indexer: CallGraphIndexer | null;
  currentFilePath: string | null;
  refreshFile(filePath: string, languageId: string, workspaceRoot: string): Promise<void>;
};

const CARD = "export function Card() { return <section />; }\n";
const FILES = {
  "src/ui/Card.tsx": CARD,
  "src/ui/index.ts": "export * from './Card';\n",
  "src/Fancy.tsx": "import { Card } from './ui';\nexport function Fancy() { return <Card />; }\n",
};

describe("CallGraphViewService save refresh re-links importers when node ids move (#575)", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-refresh-");
  });
  afterAll(() => harness.dispose());

  /** Index FILES, save `card` as Card.tsx and refresh it; returns the Fancy edges and the importer lookups. */
  async function saveCard(card: string, findImporters: (file: string) => Promise<string[]>) {
    const indexer = await harness.newIndexer();
    await harness.indexInto(indexer, FILES);
    const lookup = vi.fn(findImporters);
    const service = new CallGraphViewService({ subscriptions: [], extensionPath: harness.root } as never, lookup);
    const internals = service as unknown as Internals;
    internals.indexer = indexer;
    const cardPath = normalizePath(path.join(harness.root, "src/ui/Card.tsx"));
    internals.currentFilePath = cardPath;
    try {
      await fs.writeFile(cardPath, card);
      await internals.refreshFile(cardPath, "typescriptreact", harness.root);
      return { edges: harness.describe(indexer).edges.filter((e) => e.startsWith("src/Fancy.tsx#")), lookup };
    } finally {
      internals.indexer = null;
      indexer.dispose();
    }
  }

  it("extracts an importer behind a barrel again when the component moves down a line", async () => {
    const { edges, lookup } = await saveCard(`// moved\n${CARD}`, async () => [path.join(harness.root, "src/Fancy.tsx")]);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(edges).toEqual(["src/Fancy.tsx#Fancy -REFERENCES@1-> src/ui/Card.tsx#Card"]);
  });

  it("leaves the importers alone when the file's declarations keep their ids", async () => {
    const { edges, lookup } = await saveCard("export function Card() { return <article />; }\n", async () => []);

    expect(lookup).not.toHaveBeenCalled();
    expect(edges).toEqual(["src/Fancy.tsx#Fancy -REFERENCES@1-> src/ui/Card.tsx#Card"]);
  });

  it("drops the importers' stale edges, without failing, when the importers cannot be listed", async () => {
    const { edges } = await saveCard(`// moved\n${CARD}`, () => Promise.reject(new Error("no index")));

    expect(edges).toEqual([]);
  });
});

describe("CallGraphViewService save refresh re-links the callers of a changed return annotation (#623)", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-refresh-returns-");
  });
  afterAll(() => harness.dispose());

  const SERVICE = "export class Calculator { compute() { return 1; } }\nexport class OtherCalculator { compute() { return 2; } }\n";
  const factory = (type: string) => `import { Calculator, OtherCalculator } from './service';\nexport function make(): ${type} { return new ${type}(); }\n`;

  it.each([
    ["Calculator", "OtherCalculator", ["src/use.ts#run -> src/service.ts:compute:1"], 1],
    ["Calculator", "Calculator", ["src/use.ts#run -> src/service.ts:compute:0"], 0],
  ])("make(): %s saved as make(): %s", async (from, to, expected, lookups) => {
    const indexer = await harness.newIndexer();
    await harness.indexInto(indexer, {
      "src/service.ts": SERVICE,
      "src/factory.ts": factory(from),
      "src/use.ts": "import { make } from './factory';\nexport function run() { return make().compute(); }\n",
    });
    const lookup = vi.fn(async () => [path.join(harness.root, "src/use.ts")]);
    const service = new CallGraphViewService({ subscriptions: [], extensionPath: harness.root } as never, lookup);
    const internals = service as unknown as Internals;
    internals.indexer = indexer;
    const factoryPath = normalizePath(path.join(harness.root, "src/factory.ts"));
    internals.currentFilePath = factoryPath;
    try {
      await fs.writeFile(factoryPath, factory(to));
      await internals.refreshFile(factoryPath, "typescript", harness.root);
      const { nodes, edges } = indexer.getIndexSnapshot();
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const rel = (file: string) => path.relative(harness.root, file).replaceAll("\\", "/");
      expect(edges.filter((edge) => byId.get(edge.targetId)?.name === "compute")
        .map((edge) => `${rel(byId.get(edge.sourceId)?.path ?? "")}#run -> ${rel(byId.get(edge.targetId)?.path ?? "")}:compute:${byId.get(edge.targetId)?.startLine}`))
        .toEqual(expected);
      expect(lookup).toHaveBeenCalledTimes(lookups);
    } finally {
      internals.indexer = null;
      indexer.dispose();
    }
  });
});
