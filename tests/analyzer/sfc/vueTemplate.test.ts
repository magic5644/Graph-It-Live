/**
 * Vue template uses (#645): components, bindings, handlers, slots and `v-for`/`v-slot` scopes, at the lines
 * (1-based) and columns (0-based) of the `.vue` file.
 */
import { describe, expect, it } from "vitest";
import { analyzeVueTemplate, sfcComponentName } from "@/analyzer/sfc/vueTemplate";

let file = 0;
/** A fresh path per call: the parse cache is keyed by path and content. */
const analyze = (content: string, bindings: string[]) => analyzeVueTemplate(`/w/T${file++}.vue`, content, new Set(bindings));
const uses = (content: string, bindings: string[]) =>
  analyze(content, bindings).usages.map(({ kind, name, line, column }) => `${kind} ${name} ${line}:${column}`);

describe("analyzeVueTemplate", () => {
  it("resolves PascalCase and kebab-case tags to the binding Vue would use", () => {
    const content = "<template>\n  <Child />\n  <child-row></child-row>\n  <my-card/>\n</template>";
    expect(uses(content, ["Child", "ChildRow", "myCard"])).toEqual([
      "component Child 2:3",
      "component ChildRow 3:3",
      "component myCard 4:3",
    ]);
  });

  it("links handlers as references and calls, and interpolations to their free identifiers", () => {
    const content = '<template>\n  <button @click="save" @focus="track(item, $event)">{{ total + fmt(total) }}</button>\n</template>';
    expect(uses(content, ["save", "track", "total", "fmt", "item"])).toEqual([
      "reference save 2:18",
      "call track 2:32",
      "reference item 2:38",
      "reference total 2:56",
      "call fmt 2:64",
      "reference total 2:68",
    ]);
  });

  it("keeps v-for aliases local to the element and its children, never to its siblings", () => {
    const content = [
      "<template>",
      '  <li v-for="({ id, label }, index) in items" :key="id" :title="label + index">{{ id }}</li>',
      "  <p>{{ id }}</p>",
      "</template>",
    ].join("\n");
    expect(uses(content, ["items", "id", "label", "index"])).toEqual(["reference items 2:39", "reference id 3:8"]);
  });

  it("binds a renamed or defaulted destructured alias, never the property key, and reads its default", () => {
    const content = '<template>\n  <li v-for="({ id: key, n = limit }, i) in items" :key="key">{{ id + n + i }}</li>\n  <List v-slot="{ row = fallback }">{{ row }}</List>\n</template>';
    expect(uses(content, ["items", "id", "key", "n", "limit", "i", "List", "row", "fallback"])).toEqual([
      "reference items 2:44",
      "reference limit 2:29",
      "reference id 2:65",
      "reference fallback 3:24",
      "component List 3:3",
    ]);
  });

  it("keeps v-slot props local to the slot content, and reads slot outlets' bindings", () => {
    const content = [
      "<template>",
      '  <List v-slot="{ row }">{{ row.name + suffix }}</List>',
      '  <Table><template #cell="cell">{{ cell }}</template></Table>',
      '  <slot name="footer" :row="row" />',
      "</template>",
    ].join("\n");
    expect(uses(content, ["List", "Table", "row", "suffix", "cell"])).toEqual([
      "component List 2:3",
      "reference suffix 2:39",
      "component Table 3:3",
      "reference row 4:28",
    ]);
  });

  it("gives native elements, built-in components and unbound names no target, and reports unbound components", () => {
    const content = "<template>\n  <div><Transition><KeepAlive><keep-alive/></KeepAlive></Transition><Teleport to=\"body\"/><Suspense/></div>\n  <GlobalWidget />\n  <my-element />\n</template>";
    const result = analyze(content, ["div", "Transition"]);
    expect(result.usages).toEqual([]);
    expect(result.unresolved).toEqual([
      { name: "GlobalWidget", line: 3, column: 3 },
      { name: "my-element", line: 4, column: 3 },
    ]);
  });

  it("does not take a template variable named like a component for the script binding", () => {
    const content = '<template>\n  <div v-for="Row in rows"><Row /></div>\n</template>';
    expect(uses(content, ["Row", "rows"])).toEqual(["reference rows 2:21"]);
  });

  it("resolves a literal or bound :is and reports any other value as unresolved", () => {
    const content = [
      "<template>",
      '  <component is="Child" />',
      "  <component :is=\"'child-row'\" />",
      '  <component :is="Panel" />',
      '  <component :is="flag ? Child : Panel" />',
      '  <component :is="missing" />',
      "</template>",
    ].join("\n");
    const result = analyze(content, ["Child", "ChildRow", "Panel", "flag"]);
    expect(result.complete).toBe(false);
    expect(result.usages.map(({ kind, name, line }) => `${kind} ${name} ${line}`)).toEqual([
      "component Child 2",
      "component ChildRow 3",
      "component Panel 4",
      "reference flag 5",
      "reference Child 5",
      "reference Panel 5",
    ]);
    expect(result.unresolved).toEqual([
      { name: ':is="flag ? Child : Panel"', line: 5, column: 18 },
      { name: ':is="missing"', line: 6, column: 18 },
    ]);
  });

  it("links Options API components entries and custom directives to their bindings", () => {
    const content = [
      "<template>",
      '  <MyCard v-focus /><x-row />',
      "</template>",
      "<script>",
      'import Card from "./Card.vue";',
      'import Row from "./Row.vue";',
      "const vFocus = {};",
      "export default { components: { MyCard: Card, 'x-row': Row } };",
      "</script>",
    ].join("\n");
    expect(uses(content, ["Card", "Row", "vFocus"])).toEqual([
      "reference vFocus 2:10",
      "component Card 2:3",
      "component Row 2:21",
    ]);
  });

  it("reports the template element and positions after CRLF line breaks", () => {
    const content = "<script setup>\r\nconst total = 1;\r\n</script>\r\n\r\n<template>\r\n  <p>{{ total }}</p>\r\n</template>\r\n";
    const result = analyze(content, ["total"]);
    expect(result.template).toEqual({ line: 5, column: 0, endLine: 7 });
    expect(result.usages).toEqual([{ kind: "reference", name: "total", line: 6, column: 8 }]);
  });

  it("keeps the uses read before a malformed expression or an unclosed template", () => {
    const content = '<template>\n  <p v-if="a <">{{ total }}</p>\n  <Child :x="(" />\n';
    const result = analyze(content, ["a", "total", "Child"]);
    expect(result.usages.map((u) => u.name)).toEqual(["total", "Child"]);
    expect(result.template?.line).toBe(1);
    // The uses inside the expressions Babel could not parse are unknown.
    expect(result.complete).toBe(false);
  });

  it("reads nothing without a template, and nothing complete from an external or non-HTML template", () => {
    expect(analyze("<script setup>\nconst a = 1;\n</script>", ["a"])).toEqual({ usages: [], unresolved: [], complete: true });
    expect(analyze('<template src="./t.html"></template>', ["a"])).toEqual({ usages: [], unresolved: [], complete: false });
    expect(analyze('<template lang="pug">\nChild(:a="a")\n</template>', ["a", "Child"])).toMatchObject({ usages: [], complete: false });
    expect(analyze("<template><p>{{ a }}</p></template>", ["a"]).complete).toBe(true);
  });

  it("resolves one SFC against different binding sets", () => {
    const content = "<template><Child /></template>";
    expect(analyzeVueTemplate("/w/Same.vue", content, new Set()).usages).toEqual([]);
    expect(analyzeVueTemplate("/w/Same.vue", content, new Set(["Child"])).usages.map((u) => u.name)).toEqual(["Child"]);
  });
});

describe("sfcComponentName", () => {
  it.each([
    ["/w/src/Child.vue", "Child"],
    ["/w/src/child-row.vue", "ChildRow"],
    [String.raw`C:\w\src\my_card.vue`, "My_card"],
    ["/w/index.vue", "Index"],
  ])("%s -> %s", (filePath, name) => {
    expect(sfcComponentName(filePath)).toBe(name);
  });
});
