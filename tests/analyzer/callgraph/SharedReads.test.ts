import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeclarationReads } from "@/analyzer/utils/declarations";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness, writeFiles } from "./treeSitterHarness";

/** A barrel imported by several files: one indexing pass shares its reads and re-export resolutions (#575). */
const FILES: Record<string, string> = {
  "src/Card.tsx": "export function Card() { return null; }\nexport default function Panel() { return null; }\n",
  "src/save.ts": "export function save() {}\nexport function load() {}\n",
  "src/index.ts": "export * from './Card';\nexport * from './save';\nexport { default as Panel } from './Card';\n",
  "src/Page.tsx": "import { Card, Panel, save } from './index';\nexport function Page() { save(); return <Card onClick={save}><Panel /></Card>; }\n",
  "src/Form.tsx": "import { Card, load, save } from './index';\nexport function Form() { load(); register(save); return <Card />; }\n",
};

describe("call graph extraction with reads shared by one indexing pass", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  const extract = (name: string, reads?: DeclarationReads) =>
    harness.extractor.extractSource(normalizePath(path.join(harness.root, name)), "typescript", FILES[name], reads);

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-shared-reads-");
    await writeFiles(harness.root, FILES);
  }, 60_000);
  afterAll(() => harness.dispose());

  it("gives every importer the edges a per-file extraction gives, and reads the barrel once", async () => {
    const importers = ["src/Page.tsx", "src/Form.tsx"];
    const alone = await Promise.all(importers.map((name) => extract(name)));
    const readFile = vi.spyOn(fs, "readFile");
    try {
      const reads: DeclarationReads = new Map();
      const shared = await Promise.all(importers.map((name) => extract(name, reads)));
      expect(shared.map((result) => result.edges)).toEqual(alone.map((result) => result.edges));
      expect(shared.map((result) => result.nodes)).toEqual(alone.map((result) => result.nodes));
      const barrel = normalizePath(path.join(harness.root, "src/index.ts"));
      expect(readFile.mock.calls.filter(([file]) => normalizePath(String(file)) === barrel)).toHaveLength(1);
    } finally { readFile.mockRestore(); }
    // The cross-file targets are the declarations, not the barrel: Card, Panel (default) and save in their own modules.
    const targets = alone[0].edges.map((edge) => edge.targetId.replace(normalizePath(harness.root) + "/", ""));
    const stub = (file: string, name: string) => `@@import:${JSON.stringify([file, name])}`;
    expect(new Set(targets)).toEqual(new Set([stub("src/Card.tsx", "Card"), stub("src/Card.tsx", "Panel"), stub("src/save.ts", "save")]));
  });
});
