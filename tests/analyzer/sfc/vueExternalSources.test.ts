/**
 * External Vue sources (#646): `<template src>` is read when it is HTML inside the workspace root (no escape through
 * `..` or a symbolic link), and `<script src>` / `<template src>` are file dependencies of the `.vue`, so an edit of
 * the external file reaches its owning SFC.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { analyzeVueTemplate, readExternalTemplate } from "@/analyzer/sfc/vueTemplate";
import { MAX_TEXT_FILE_BYTES } from "@/analyzer/utils/workspaceText";
import { normalizePath } from "@/shared/path";

const CARD = '<script setup lang="ts">\nimport Child from "./Child.vue";\nimport { save } from "./save";\n</script>\n\n<template src="./card.html"></template>\n';
const CARD_HTML = '<div>\n  <Child />\n  <button @click="save()">x</button>\n</div>\n';
const LOGIC = '<script src="./logic.ts"></script>\n<template><p>{{ total }}</p></template>\n';

let base: string;
let root: string;
const file = (name: string) => path.join(root, name);
const write = (name: string, content: string) => fs.writeFileSync(file(name), content);
const uses = (name: string, bindings: string[], rootDir: string | undefined) => {
  const analysis = analyzeVueTemplate(file(name), fs.readFileSync(file(name), "utf8"), new Set(bindings), rootDir);
  return { ...analysis, uses: analysis.usages.map(({ kind, name: used, line, column }) => `${kind} ${used} ${line}:${column}`) };
};

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vue-external-")));
  root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "t.html"), "<Child />\n");
  // A junction needs no privilege on Windows and is a symbolic link elsewhere.
  fs.symlinkSync(outside, file("linked"), "junction");
  write("Card.vue", CARD);
  write("card.html", CARD_HTML);
  write("Child.vue", "<template><p /></template>\n");
  write("save.ts", "export function save(): void {}\n");
  write("Logic.vue", LOGIC);
  write("logic.ts", "export default { data: () => ({ total: 1 }) };\n");
  write("Outside.vue", '<template src="../outside/t.html"></template>\n');
  write("Linked.vue", '<template src="./linked/t.html"></template>\n');
  write("Pug.vue", '<template src="./t.pug"></template>\n');
  write("t.pug", "Child\n");
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("analyzeVueTemplate with an external template", () => {
  it("reads an HTML template inside the root, its uses at the <template src> element", () => {
    const { uses: found, complete, template } = uses("Card.vue", ["Child", "save"], root);
    expect(found).toEqual(["component Child 6:0", "call save 6:0"]);
    expect(complete).toBe(true);
    expect(template).toEqual({ line: 6, column: 0, endLine: 6 });
  });

  it.each([
    ["without a workspace root", "Card.vue", undefined],
    ["outside the root through ..", "Outside.vue", "root"],
    ["outside the root through a symbolic link", "Linked.vue", "root"],
    ["that is not HTML", "Pug.vue", "root"],
  ])("leaves a template %s partial and unread", (_case, name, rootDir) => {
    const analysis = uses(name, ["Child", "save"], rootDir && root);
    expect(analysis.uses).toEqual([]);
    expect(analysis.complete).toBe(false);
    expect(analysis.template).toBeUndefined();
  });

  it("reads an empty external template as complete, with no use", () => {
    write("Empty.vue", '<script setup>\nimport Child from "./Child.vue";\n</script>\n<template src="./empty.html"></template>\n');
    write("empty.html", "");
    const analysis = uses("Empty.vue", ["Child"], root);
    expect([analysis.uses, analysis.complete, analysis.template?.line]).toEqual([[], true, 4]);
  });

  it("reads the external template again once it is edited, the .vue unchanged", () => {
    write("card.html", "<div><Child /></div>\n");
    try {
      expect(uses("Card.vue", ["Child", "save"], root).uses).toEqual(["component Child 6:0"]);
    } finally {
      write("card.html", CARD_HTML);
    }
    expect(uses("Card.vue", ["Child", "save"], root).uses).toEqual(["component Child 6:0", "call save 6:0"]);
  });
});

describe("readExternalTemplate", () => {
  it("refuses a missing file, an absolute path outside the root and a file over the size limit", () => {
    expect(readExternalTemplate(file("Card.vue"), "./card.html", root)).toBe(CARD_HTML);
    expect(readExternalTemplate(file("Card.vue"), "./missing.html", root)).toBeUndefined();
    expect(readExternalTemplate(file("Card.vue"), path.join(base, "outside", "t.html"), root)).toBeUndefined();
    write("big.html", "x".repeat(MAX_TEXT_FILE_BYTES + 1));
    expect(readExternalTemplate(file("Card.vue"), "./big.html", root)).toBeUndefined();
  });
});

describe("external sources as dependencies", () => {
  it("parses <script src> and <template src> as imports at their block line", () => {
    const parser = new Parser();
    expect(parser.parse(LOGIC, file("Logic.vue"))).toEqual([{ module: "./logic.ts", type: "import", line: 1 }]);
    expect(parser.parse(CARD, file("Card.vue")).map(({ module, line }) => `${module}@${line}`)).toEqual([
      "./card.html@6",
      "./Child.vue@2",
      "./save@3",
    ]);
  });

  it("links the .vue to its external files inside the root and names it owner of its HTML template", async () => {
    const spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    try {
      const deps = await spider.analyze(file("Card.vue"));
      expect(deps.map((dep) => normalizePath(dep.path))).toContain(normalizePath(file("card.html")));
      expect((await spider.analyze(file("Logic.vue"))).map((dep) => normalizePath(dep.path))).toEqual([normalizePath(file("logic.ts"))]);
      // Out of the root, through `..` or a link: no dependency.
      expect(await spider.analyze(file("Outside.vue"))).toEqual([]);
      expect(await spider.analyze(file("Linked.vue"))).toEqual([]);

      expect(spider.getExternalTemplateOwners(file("card.html")).map(normalizePath)).toEqual([normalizePath(file("Card.vue"))]);
      // Only HTML is an external template; a script imported by a `.vue` keeps its own events.
      expect(spider.getExternalTemplateOwners(file("save.ts"))).toEqual([]);
      expect(spider.getExternalTemplateOwners(file("other.html"))).toEqual([]);
    } finally {
      await spider.dispose();
    }
  });
});
