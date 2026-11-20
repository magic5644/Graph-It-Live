/**
 * Names a project's generated auto-import declarations bind (Nuxt `.nuxt/*.d.ts`, unplugin `auto-imports.d.ts` /
 * `components.d.ts`) link as imports of the declared export; any other bare name is never guessed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutoImports, isAutoImportDeclaration, readDeclarations, type AutoImport } from "@/analyzer/callgraph/autoImports";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness, writeFiles } from "./treeSitterHarness";

let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
beforeAll(async () => { harness = await createTreeSitterHarness("auto-imports-"); });
afterAll(() => harness.dispose());

const ESCAPE = `escape-${process.pid}.ts`;

describe("call graph edges", () => {
  it("links Nuxt auto-imported composables and components, never a package, node_modules or outside entry", async () => {
    fs.writeFileSync(path.join(harness.root, "..", ESCAPE), "export function useOutside() {}\n");
    await writeFiles(harness.root, {
      "nuxt/package.json": JSON.stringify({ devDependencies: { nuxt: "^3" } }),
      "nuxt/.nuxt/imports.d.ts": [
        "export { useCounter, default as useTheme } from '../composables/counter';",
        "export { ref, computed } from 'vue';",
        "export { useModule } from '../node_modules/mod/index';",
        `export { useOutside } from '../../../${ESCAPE.replace(".ts", "")}';`,
        "export type { Counter } from '../composables/counter';",
      ].join("\n"),
      "nuxt/.nuxt/components.d.ts": [
        "interface _GlobalComponents {",
        "  'BaseCard': typeof import(\"../components/BaseCard.vue\")['default']",
        "  'LazyBaseCard': LazyComponent<typeof import(\"../components/BaseCard.vue\")['default']>",
        "}",
      ].join("\n"),
      "nuxt/node_modules/mod/index.ts": "export function useModule() {}\n",
    });
    const { edges } = await harness.index({
      "nuxt/composables/counter.ts": "export function useCounter() {}\nexport default function useTheme() {}\nexport function ref() {}\n",
      "nuxt/components/BaseCard.vue": "<template><div/></template>\n<script setup lang=\"ts\">\n</script>\n",
      "nuxt/pages/index.vue": [
        "<template><BaseCard/><lazy-base-card/><Unknown/></template>",
        "<script setup lang=\"ts\">",
        "function load() { useCounter(); useTheme(); ref(1); useModule(); useOutside(); useUndeclared(); }",
        "</script>",
      ].join("\n"),
      "nuxt/utils/run.ts": "export function run() { useCounter(); }\n",
    });
    expect(edges.filter(edge => edge.startsWith("nuxt/pages") || edge.startsWith("nuxt/utils")).sort()).toEqual([
      "nuxt/pages/index.vue#Index -REFERENCES@0-> nuxt/components/BaseCard.vue#BaseCard",
      "nuxt/pages/index.vue#load -CALLS@2-> nuxt/composables/counter.ts#useCounter",
      "nuxt/pages/index.vue#load -CALLS@2-> nuxt/composables/counter.ts#useTheme",
      "nuxt/utils/run.ts#run -CALLS@0-> nuxt/composables/counter.ts#useCounter",
    ]);
  });

  it("links unplugin auto-imports and components, a local declaration shadowing them", async () => {
    await writeFiles(harness.root, {
      "vite/package.json": "{}",
      "vite/vite.config.ts": "import AutoImport from 'unplugin-auto-import/vite'\nexport default { plugins: [AutoImport({ dts: 'src/auto-imports.d.ts' })] }\n",
      "vite/src/auto-imports.d.ts": [
        "export {}",
        "declare global {",
        "  const useDark: typeof import('./composables/dark')['useDark']",
        "  const ref: typeof import('vue')['ref']",
        "}",
      ].join("\n"),
      "vite/src/components.d.ts": [
        "declare module 'vue' {",
        "  export interface GlobalComponents {",
        "    TheFooter: typeof import('./components/TheFooter.vue')['default']",
        "  }",
        "}",
      ].join("\n"),
    });
    const { edges } = await harness.index({
      "vite/src/composables/dark.ts": "export function useDark() {}\n",
      "vite/src/components/TheFooter.vue": "<template><div/></template>\n<script setup lang=\"ts\">\n</script>\n",
      "vite/src/pages/home.vue": "<template><TheFooter/></template>\n<script setup lang=\"ts\">\nfunction toggle() { useDark(); ref(0); }\n</script>\n",
      "vite/src/own.ts": "export function useDark() {}\nexport function f() { useDark(); }\n",
    });
    expect(edges.filter(edge => edge.startsWith("vite/src/pages") || edge.startsWith("vite/src/own")).sort()).toEqual([
      "vite/src/own.ts#f -CALLS@1-> vite/src/own.ts#useDark",
      "vite/src/pages/home.vue#Home -REFERENCES@0-> vite/src/components/TheFooter.vue#TheFooter",
      "vite/src/pages/home.vue#toggle -CALLS@2-> vite/src/composables/dark.ts#useDark",
    ]);
  });

  it("leaves a file outside any project with declarations as before", async () => {
    const { edges } = await harness.index({
      "plain/a.ts": "export function a() { useCounter(); }\n",
      "plain/b.ts": "export function useCounter() {}\n",
    });
    expect(edges.filter(edge => edge.startsWith("plain/"))).toEqual([]);
  });
});

describe("declaration reader", () => {
  const read = (content: string, from = "/w/p/.nuxt/imports.d.ts") => {
    const names = new Map<string, AutoImport>();
    readDeclarations(content, from, names);
    return Object.fromEntries(names);
  };

  it("reads export lists, typeof import forms, absolute specifiers and package entries, never type exports", () => {
    expect(read([
      "export { a, b as c } from '../x';",
      "export { d } from '/w/p/composables/d';",
      "export { v } from 'vue';",
      "export { n } from '../node_modules/n';",
      "export type { T } from '../x';",
      "declare global { const e: typeof import('./e')['e']; readonly e2: UnwrapRef<typeof import('./e')['e2']>; const e3: typeof import('./e').e3 }",
    ].join("\n"))).toEqual({
      a: { from: "/w/p/.nuxt/imports.d.ts", specifier: "../x", imported: "a" },
      c: { from: "/w/p/.nuxt/imports.d.ts", specifier: "../x", imported: "b" },
      d: { from: "/w/p/.nuxt/imports.d.ts", specifier: "./../composables/d", imported: "d" },
      v: { from: "/w/p/.nuxt/imports.d.ts", specifier: "vue", imported: "v" },
      n: { from: "/w/p/.nuxt/imports.d.ts", specifier: "../node_modules/n", imported: "n" },
      e: { from: "/w/p/.nuxt/imports.d.ts", specifier: "./e", imported: "e" },
      e2: { from: "/w/p/.nuxt/imports.d.ts", specifier: "./e", imported: "e2" },
      e3: { from: "/w/p/.nuxt/imports.d.ts", specifier: "./e", imported: "e3" },
    });
  });

  it("keeps the first declaration of a name", () => {
    expect(read("const a: typeof import('./one')['a']\nconst a: typeof import('./two')['a']\n").a?.specifier).toBe("./one");
  });

  it("tells declaration files and the .nuxt folder to a watcher", () => {
    expect(isAutoImportDeclaration(".nuxt")).toBe(true);
    expect(isAutoImportDeclaration("app/.nuxt/imports.d.ts")).toBe(true);
    expect(isAutoImportDeclaration("app/.nuxt/types/imports.d.ts")).toBe(false);
    expect(isAutoImportDeclaration(".nuxt/nuxt.d.ts")).toBe(false);
    expect(isAutoImportDeclaration("src/auto-imports.d.ts")).toBe(true);
    expect(isAutoImportDeclaration("components.d.ts")).toBe(true);
    expect(isAutoImportDeclaration("src/index.ts")).toBe(false);
  });
});

describe("projects", () => {
  let root: string;
  beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auto-import-projects-"))); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (files: Record<string, string>) => writeFiles(root, files);

  it("reports a Nuxt project without .nuxt/imports.d.ts and a Vite project without its dts", async () => {
    await write({
      "package.json": "{}",
      "nuxt/package.json": JSON.stringify({ dependencies: { nuxt: "^3" } }),
      "nuxt/app.vue": "",
      "nuxt/nuxt.config.ts": "export default {}",
      "module/package.json": JSON.stringify({ devDependencies: { nuxt: "^3" } }),
      "module/a.ts": "",
      "vite/package.json": "{}",
      "vite/vite.config.ts": "import AutoImport from 'unplugin-auto-import/vite'\nimport Components from 'unplugin-vue-components/vite'\n",
      "vite/src/main.ts": "",
      "conf/package.json": "{}",
      "conf/vite.config.mjs": "AutoImport({ dts: 'types/auto.d.ts' })",
      "conf/a.ts": "",
      "off/package.json": "{}",
      "off/vite.config.js": "AutoImport({ dts: false }) // unplugin-auto-import",
      "off/a.ts": "",
      "bad/package.json": "{ not json",
      "bad/a.ts": "",
    });
    const projects = new AutoImports(root).projectsOf(["nuxt/app.vue", "module/a.ts", "vite/src/main.ts", "conf/a.ts", "off/a.ts", "bad/a.ts", "top.ts"].map(f => path.join(root, f)));
    const missing = Object.fromEntries(projects.map(p => [path.relative(root, p.root) || ".", p.missing.map(m => m.source)]));
    expect(missing).toEqual({
      ".": [],
      nuxt: [".nuxt/imports.d.ts"],
      module: [],
      vite: ["auto-imports.d.ts", "components.d.ts"],
      conf: ["types/auto.d.ts"],
      off: [],
      bad: [],
    });
    expect(projects.every(p => p.hash === "" && p.sources.length === 0)).toBe(true);
  });

  it("hashes the declarations read and finds the project of a nested file once", async () => {
    await write({ "h/package.json": "{}", "h/components.d.ts": "Foo: typeof import('./Foo.vue')['default']", "h/deep/er/x.ts": "" });
    const autoImports = new AutoImports(root);
    const project = autoImports.forFile(path.join(root, "h/deep/er/x.ts"));
    expect(project?.root).toBe(normalizePath(path.join(root, "h")));
    expect(project?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect([...(project?.names.keys() ?? [])]).toEqual(["Foo"]);
    expect(autoImports.forFile(path.join(root, "h/deep/y.ts"))).toBe(project);
    expect(autoImports.forFile(path.join(os.tmpdir(), "elsewhere.ts"))).toBeNull();
  });

  it("never reads a configured dts outside the workspace, even when it exists", async () => {
    const outside = path.join(root, "..", `outside-${process.pid}.d.ts`);
    fs.writeFileSync(outside, "declare global { const useOutside: typeof import('./x')['useOutside'] }\n");
    try {
      await write({ "out/package.json": "{}", "out/vite.config.ts": `AutoImport({ dts: '../../${path.basename(outside)}' })`, "out/a.ts": "" });
      const project = new AutoImports(root).forFile(path.join(root, "out/a.ts"));
      expect(project?.sources).toEqual([]);
      expect(project?.names.has("useOutside")).toBe(false);
      expect(project?.missing).toEqual([{ source: `../../${path.basename(outside)}`, hint: "outside the workspace: not read" }]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
