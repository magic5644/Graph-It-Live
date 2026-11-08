import fs from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import { describe, expect, it, vi } from "vitest";
import { isSfcFile, langOf, parseSfc, scriptKindOf, type SfcScript } from "@/analyzer/sfc/sfcBlocks";

const FIXTURES = path.resolve(__dirname, "../fixtures/vue");
// LF as committed: a Windows checkout may turn the fixtures into CRLF; CRLF cases are built explicitly.
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").replaceAll("\r\n", "\n");

/** Every non-blank character of the script view sits where it sits in the SFC; everything else is a space or a line break. */
function expectSamePositions(content: string, view: string): void {
  expect(view).toHaveLength(content.length);
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== " ") expect(view[i]).toBe(content[i]);
    if (content[i] === "\n" || content[i] === "\r") expect(view[i]).toBe(content[i]);
  }
}

describe("parseSfc (Vue)", () => {
  it("keeps both script blocks in place and blanks the template", () => {
    const content = fixture("TwoBlocks.vue");
    const sfc = parseSfc("/w/TwoBlocks.vue", content);

    expect(sfc.errors).toEqual([]);
    expect(sfc.scripts.map(({ lang, setup }) => ({ lang, setup }))).toEqual([{ lang: "ts", setup: false }, { lang: "ts", setup: true }]);
    expect(sfc.scripts.map(({ loc }) => content.slice(loc.start, loc.end).trim().split("\n")[0])).toEqual([
      "export const LIMIT = 10;",
      'import { add } from "./utils/math";',
    ]);
    expect(sfc.template?.content.trim()).toBe("<p>{{ capped(12) }}</p>");
    expectSamePositions(content, sfc.scriptView);
    expect(sfc.scriptView).not.toContain("capped(12)");
    expect(sfc.scriptView.split("\n")[12]).toBe("  return Math.min(add(n, 0), LIMIT);");
  });

  it("keeps CRLF line breaks, so lines and columns match the file", () => {
    const content = fixture("ScriptSetupTs.vue").replaceAll("\n", "\r\n");
    const sfc = parseSfc("/w/Crlf.vue", content);

    expectSamePositions(content, sfc.scriptView);
    expect(sfc.scriptView.split("\r\n")[10]).toBe("  return add(4, 5);");
  });

  it.each([
    ["no lang", "<script>const a = 1</script>", "js"],
    ["lang ts", '<script lang="ts">const a = 1</script>', "ts"],
    ["lang tsx", '<script setup lang="tsx">const a = 1</script>', "tsx"],
    ["lang jsx", "<script lang='jsx'>const a = 1</script>", "jsx"],
    ["lang typescript", '<script lang="TypeScript">const a = 1</script>', "ts"],
    ["unknown lang", '<script lang="coffee">a = 1</script>', "js"],
  ])("reads the script language (%s)", (_name, content, lang) => {
    expect(parseSfc(`/w/${_name}.vue`, content).scripts[0].lang).toBe(lang);
  });

  it("reads setup and an external src without inventing content", () => {
    const sfc = parseSfc("/w/External.vue", '<template src="./t.html"></template>\n<script setup src="./s.ts"></script>');

    expect(sfc.scripts).toEqual([{ lang: "js", setup: true, loc: expect.anything(), src: "./s.ts" }]);
    expect(sfc.scripts[0].loc.end).toBe(sfc.scripts[0].loc.start);
    expect(sfc.template).toEqual({ loc: expect.anything(), element: { start: 0, end: 36 }, content: "", src: "./t.html" });
    expect(sfc.scriptView.trim()).toBe("");
  });

  it("returns an empty view for a template-only SFC", () => {
    const content = fixture("TemplateOnly.vue");
    const sfc = parseSfc("/w/TemplateOnly.vue", content);

    expect(sfc.scripts).toEqual([]);
    expect(sfc.template?.content.trim()).toBe("<p>static</p>");
    expect(sfc.scriptView.trim()).toBe("");
    expect(sfc.scriptView).toHaveLength(content.length);
  });

  it("reports errors and keeps the readable part of a malformed SFC, never throwing", () => {
    const content = fixture("Malformed.vue");
    const sfc = parseSfc("/w/Malformed.vue", content);

    expect(sfc.errors.length).toBeGreaterThan(0);
    expect(sfc.scripts).toHaveLength(1);
    // The unclosed <script setup> runs to the end of the file.
    expect(sfc.scriptView.split("\n")[5]).toBe('import { add } from "./utils/math";');
    expectSamePositions(content, sfc.scriptView);
  });

  it.each(["", "<", "<script", "</script>", "<template><div></template>", "<script>a</script><script"])("never throws on %j", (content) => {
    const sfc = parseSfc("/w/Broken.vue", content);
    expect(sfc.scriptView).toHaveLength(content.length);
  });

  it("reuses the parse of an unchanged file and parses again after an edit", () => {
    const first = parseSfc("/w/Cached.vue", "<script>const a = 1</script>");

    expect(parseSfc("/w/Cached.vue", "<script>const a = 1</script>")).toBe(first);
    expect(parseSfc("/w/Cached.vue", "<script>const a = 2</script>")).not.toBe(first);
  });

  it("keys the cache on the normalized path: Windows separators and drive-letter case hit the same entry", () => {
    const first = parseSfc(String.raw`C:\w\src\Key.vue`, "<script>const a = 1</script>");
    expect(parseSfc("c:/w/src/Key.vue", "<script>const a = 1</script>")).toBe(first);
  });

  it("stays bounded: past its limit the cache starts over", () => {
    const first = parseSfc("/w/Bounded0.vue", "<script>const a = 0</script>");
    for (let i = 1; i <= 64; i++) parseSfc(`/w/Bounded${i}.vue`, "<script>const a = 0</script>");

    expect(parseSfc("/w/Bounded0.vue", "<script>const a = 0</script>")).not.toBe(first);
  });
});

describe("parseSfc (Svelte)", () => {
  it("splits instance and module scripts with the block regex, positions kept", () => {
    const content = [
      '<script context="module" lang="ts">',
      "  export const prerender = true;",
      "</script>",
      "",
      "<script>",
      "  import Card from './Card.svelte';",
      "</script>",
      "",
      "{#if ok}<Card />{/if}",
    ].join("\n");
    const sfc = parseSfc("/w/Page.svelte", content);

    expect(sfc.scripts.map(({ lang, setup }) => ({ lang, setup }))).toEqual([{ lang: "ts", setup: false }, { lang: "js", setup: false }]);
    expect(sfc.template).toBeUndefined();
    expectSamePositions(content, sfc.scriptView);
    expect(sfc.scriptView.split("\n")[5]).toBe("  import Card from './Card.svelte';");
    expect(sfc.scriptView).not.toContain("{#if");
  });

  it("returns an empty view for markup without script", () => {
    expect(parseSfc("/w/Plain.svelte", "<h1>Hi</h1>").scriptView).toBe("           ");
  });
});

describe("langOf / scriptKindOf", () => {
  const scripts = (...langs: SfcScript["lang"][]): SfcScript[] => langs.map((lang) => ({ lang, setup: false, loc: { start: 0, end: 0 } }));

  it.each([
    [[], "js", ts.ScriptKind.JS],
    [["js"], "js", ts.ScriptKind.JS],
    [["ts"], "ts", ts.ScriptKind.TS],
    [["tsx"], "tsx", ts.ScriptKind.TSX],
    [["jsx"], "jsx", ts.ScriptKind.JSX],
    [["ts", "js"], "ts", ts.ScriptKind.TS],
    [["ts", "jsx"], "tsx", ts.ScriptKind.TSX],
    [["js", "jsx"], "jsx", ts.ScriptKind.JSX],
  ] as const)("%j gives %s", (langs, lang, kind) => {
    expect(langOf(scripts(...langs))).toBe(lang);
    expect(scriptKindOf(scripts(...langs))).toBe(kind);
  });
});

describe("isSfcFile", () => {
  it.each([
    ["C:\\app\\src\\App.vue", true],
    ["/app/src/Page.SVELTE", true],
    ["/app/src/App.vue.ts", false],
    ["/app/src/main.ts", false],
  ])("%s → %s", (filePath, expected) => {
    expect(isSfcFile(filePath)).toBe(expected);
  });
});

describe("lazy Vue compiler", () => {
  it("is never loaded by the import parser, symbol analysis or Svelte; the first .vue loads it", async () => {
    vi.resetModules();
    const sfc = await import("@/analyzer/sfc/sfcBlocks");
    const { Parser } = await import("@/analyzer/Parser");
    const { SymbolAnalyzer } = await import("@/analyzer/SymbolAnalyzer");
    const source = 'import { add } from "./math";\nexport const total = add(1, 2);\n';

    new Parser().parse(source, "/w/src/main.ts");
    new SymbolAnalyzer().analyzeFileContent("/w/src/main.ts", source);
    sfc.parseSfc("/w/src/Page.svelte", `<script>${source}</script>`);
    expect(sfc.isVueCompilerLoaded()).toBe(false);

    new Parser().parse(`<script setup>${source}</script>`, "/w/src/App.vue");
    expect(sfc.isVueCompilerLoaded()).toBe(true);
  });
});
