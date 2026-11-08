/**
 * Vue props/emits contracts (#646): the names a `.vue` declares literally, and partial when they are not written.
 */
import { describe, expect, it } from "vitest";
import { compareVueContracts as compareEntries, readVueContract, type VueContract } from "@/analyzer/sfc/vueContract";

/** The change as its evidence lines. */
const compareVueContracts = (base: VueContract, head: VueContract) => {
  const { removed, added, partial } = compareEntries(base, head);
  return { removed: removed.map((entry) => entry.detail), added: added.map((entry) => entry.detail), partial };
};

let file = 0;
/** A fresh path per call: the SFC parse cache is keyed by path and content. */
const contract = (script: string, attributes = 'setup lang="ts"') =>
  readVueContract(`/w/C${file++}.vue`, `<script ${attributes}>\n${script}\n</script>\n<template><p /></template>\n`);
const names = (script: string, attributes?: string) => {
  const { props, emits, partial } = contract(script, attributes);
  return { props, emits, partial };
};

describe("readVueContract", () => {
  it.each([
    ["an array", "defineProps(['label', 'size']);"],
    ["a runtime object", "defineProps({ label: String, size: { type: Number, required: true } });"],
    ["a type literal", "defineProps<{ label: string; size?: number }>();"],
    ["a type literal under withDefaults", "withDefaults(defineProps<{ label?: string; size?: number }>(), { label: 'x' });"],
    ["a local interface", "interface Props { label: string; size(): number }\ndefineProps<Props>();"],
    ["a local type literal alias", "type Props = { 'label': string; size: number };\nconst props = defineProps<Props>();"],
  ])("reads props declared as %s", (_form, script) => {
    expect(names(script)).toEqual({ props: ["label", "size"], emits: [], partial: [] });
  });

  it.each([
    ["an array", "defineEmits(['save', 'update:title']);"],
    ["a runtime object", "defineEmits({ save: (id: number) => id > 0, 'update:title': null });"],
    ["a named tuple type literal", "defineEmits<{ save: [id: number]; 'update:title': [value: string] }>();"],
    ["call signatures", "defineEmits<{ (e: 'save', id: number): void; (e: 'update:title'): void }>();"],
    ["a call signature with a union", "defineEmits<{ (e: 'save' | 'update:title'): void }>();"],
  ])("reads events declared as %s", (_form, script) => {
    expect(names(script)).toEqual({ props: [], emits: ["save", "update:title"], partial: [] });
  });

  it("reads defineModel as a prop and its update event, default or named", () => {
    expect(names("const model = defineModel<string>();\nconst count = defineModel('count', { default: 0 });\nconst open = defineModel({ required: true });")).toEqual({
      props: ["count", "modelValue"], emits: ["update:count", "update:modelValue"], partial: [],
    });
  });

  it.each([
    ["a plain object", "export default { props: ['label'], emits: { save: null } };"],
    ["defineComponent", "import { defineComponent } from 'vue';\nexport default defineComponent({ props: { label: String }, emits: ['save'], data: () => ({}) });"],
  ])("reads the Options API through %s", (_form, script) => {
    expect(names(script, 'lang="ts"')).toEqual({ props: ["label"], emits: ["save"], partial: [] });
  });

  it.each([
    ["props typed by an imported type", "import type { Props } from './types';\ndefineProps<Props>();", "props are typed by 'Props', not declared in this file"],
    ["props built at runtime", "import { shared } from './shared';\ndefineProps(shared);", "props are built at runtime"],
    ["a spread entry", "const base = { a: String };\ndefineProps({ ...base, label: String });", "props hold a spread or computed entry"],
    ["a computed event", "const name = 'save';\ndefineEmits({ [name]: null });", "emits hold a spread or computed entry"],
    ["an event typed by a type", "type Name = 'save';\ndefineEmits<{ (e: Name): void }>();", "emits hold a member whose name is not a literal"],
    ["a model named at runtime", "const name = 'x';\ndefineModel(name);", "defineModel names its prop at runtime"],
    ["Options API props from a variable", "const props = ['label'];\nexport default { props };", "props are built at runtime"],
  ])("marks %s as partial and keeps the literal names", (_case, script, reason) => {
    expect(contract(script, 'setup lang="ts"').partial).toEqual([reason]);
  });

  it("marks an external <script src> as partial", () => {
    expect(readVueContract("/w/External.vue", '<script src="./logic.ts"></script>\n<template><p /></template>\n').partial).toEqual(["the script is an external <script src>"]);
  });

  it("reads nothing from a malformed script, a component without contract or a same-named method call", () => {
    expect(names("defineProps(['label'")).toEqual({ props: ["label"], emits: [], partial: [] });
    expect(names("const total = 1;")).toEqual({ props: [], emits: [], partial: [] });
    expect(names("api.defineProps(['label']);\ndefineProps();")).toEqual({ props: [], emits: [], partial: [] });
    expect(readVueContract("/w/TemplateOnly.vue", "<template><p /></template>\n")).toEqual({ props: [], emits: [], partial: [], declarations: [] });
  });
});

describe("compareVueContracts", () => {
  const base = contract("defineProps<{ label: string; size: number }>();\ndefineEmits(['save']);");

  it("lists removed and added props and events by name", () => {
    const head = contract("defineProps<{ label: string; color: string }>();\ndefineEmits(['save', 'close']);");
    expect(compareVueContracts(base, head)).toEqual({ removed: ["prop 'size' removed"], added: ["prop 'color' added", "event 'close' added"], partial: [] });
  });

  it("reports nothing for an unchanged contract, even partial", () => {
    expect(compareVueContracts(base, contract("defineProps<{ label: string; size: number }>();\ndefineEmits(['save']);"))).toEqual({ removed: [], added: [], partial: [] });
    const imported = "import type { P } from './p';\ndefineProps<P>();";
    expect(compareVueContracts(contract(imported), contract(imported))).toEqual({ removed: [], added: [], partial: [] });
  });

  it("reports a changed partial contract as partial, its names unknown", () => {
    const head = contract("import type { Other } from './p';\ndefineProps<Other>();\ndefineEmits(['save']);");
    expect(compareVueContracts(base, head)).toEqual({
      removed: ["prop 'label' removed", "prop 'size' removed"], added: [], partial: ["props are typed by 'Other', not declared in this file"],
    });
  });
});
