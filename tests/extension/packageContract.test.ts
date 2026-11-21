import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fileExtToLang } from "../../src/analyzer/callgraph/GraphExtractor";
import { SUPPORTED_SOURCE_EXTENSIONS, SUPPORTED_SOURCE_FILE_REGEX } from "../../src/shared/constants";

// The VS Code contract (#770): package.json declares what the code does, and nothing else.
interface SettingSchema {
  type: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}
interface MenuEntry { command: string; when?: string }

const repoRoot = path.resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  contributes: {
    configuration: Array<{ properties: Record<string, SettingSchema> }>;
    commands: Array<{ command: string }>;
    menus: Record<string, MenuEntry[]>;
  };
};
const settings = Object.assign({}, ...pkg.contributes.configuration.map((section) => section.properties)) as Record<
  string,
  SettingSchema
>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
const extensionSource = sourceFiles(path.join(repoRoot, "src", "extension"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

// Commands opened from a view item: from the palette they would get no argument.
const ITEM_COMMANDS = [
  "graph-it-live.reviewCallGraph",
  "graph-it-live.branchWatch.openFile",
  "graph-it-live.branchWatch.copyMessage",
  "graph-it-live.branchWatch.openCallGraph",
  "graph-it-live.branchWatch.openCycle",
];

describe("package.json settings", () => {
  // shortcut: a quoted name anywhere in src/extension counts as read; the typed-get test below is the strict check.
  it("declares only settings the extension reads", () => {
    const unread = Object.keys(settings).filter((key) => {
      const name = key.replace("graph-it-live.", "");
      return !extensionSource.includes(`'${name}'`) && !extensionSource.includes(`"${name}"`)
        && !extensionSource.includes(`'${key}'`) && !extensionSource.includes(`"${key}"`);
    });
    expect(unread).toEqual([]);
  });

  it("declares every setting the extension reads", () => {
    // Setting reads are typed (`config.get<boolean>("x")`); untyped `.get("x")` calls are state and Map lookups.
    const read = new Set<string>();
    for (const match of extensionSource.matchAll(/\.get<[^>(]+>\(\s*["']([\w.]+)["']/g)) {
      read.add(`graph-it-live.${match[1]}`);
    }
    expect(read.size).toBeGreaterThan(5);
    expect([...read].filter((key) => !(key in settings))).toEqual([]);
  });

  it("types whole numbers as integers with both bounds", () => {
    for (const [key, schema] of Object.entries(settings)) {
      if (schema.type !== "number" && schema.type !== "integer") continue;
      expect(schema.type, key).toBe("integer");
      expect(schema.minimum, `${key} minimum`).toBeTypeOf("number");
      expect(schema.maximum, `${key} maximum`).toBeTypeOf("number");
      expect(Number(schema.default), `${key} default`).toBeGreaterThanOrEqual(schema.minimum ?? 0);
      expect(Number(schema.default), `${key} default`).toBeLessThanOrEqual(schema.maximum ?? 0);
    }
  });

  it("keeps each enum default inside its enum", () => {
    for (const [key, schema] of Object.entries(settings)) {
      if (schema.enum) expect(schema.enum, key).toContain(schema.default);
    }
  });
});

describe("package.json commands", () => {
  const contributed = pkg.contributes.commands.map((entry) => entry.command);

  it("registers every contributed command, and contributes every registered one", () => {
    const registered = new Set(
      [...extensionSource.matchAll(/register(?:\w*Command)?\(\s*[`'"](graph-it-live\.[\w.]+)[`'"]/g)].map((match) => match[1]),
    );
    for (const match of extensionSource.matchAll(/command\(\s*'([\w]+)'/g)) registered.add(`graph-it-live.branchWatch.${match[1]}`);
    for (const match of extensionSource.matchAll(/itemCommand\(\s*'([\w]+)'/g)) registered.add(`graph-it-live.branchWatch.${match[1]}`);
    // Test-only commands are registered in ExtensionMode.Test and are not contributed.
    const testOnly = new Set(["graph-it-live.getContext", "graph-it-live.branchWatch.testSnapshot"]);
    expect(contributed.filter((id) => !registered.has(id))).toEqual([]);
    expect([...registered].filter((id) => !contributed.includes(id) && !testOnly.has(id) && !/e2e/i.test(id))).toEqual([]);
  });

  it("hides item commands from the Command Palette", () => {
    const palette = new Map(pkg.contributes.menus.commandPalette.map((entry) => [entry.command, entry.when]));
    for (const id of ITEM_COMMANDS) {
      expect(contributed).toContain(id);
      expect(palette.get(id), id).toBe("false");
    }
  });

  it("offers Show Flow Diagram in the editor menu for exactly the call graph's files (#795)", () => {
    const entry = pkg.contributes.menus["editor/context"].find((item) => item.command === "graph-it-live.showFlowDiagram") as MenuEntry & { group?: string };
    const match = /^editorTextFocus && resourceExtname =~ \/\\\.\(([\w|]+)\)\$\/$/.exec(entry?.when ?? "");
    expect(match, entry?.when).not.toBeNull();
    // The call graph reads every source extension but the .csproj XML (CallGraphViewService langFromPath).
    const callGraph = SUPPORTED_SOURCE_EXTENSIONS.filter((extension) => extension !== "csproj" && fileExtToLang(`a.${extension}`) !== null);
    expect(match![1].split("|").sort()).toEqual([...callGraph].sort());
    expect(entry.group).toBe("navigation@98");
  });

  it("offers Show Diagram on Explorer files and Show Folder Diagram on Explorer folders (#795)", () => {
    const explorer = pkg.contributes.menus["explorer/context"] as (MenuEntry & { group?: string })[];
    expect(explorer.map(({ command, when, group }) => [command, when, group])).toEqual([
      ["graph-it-live.showDiagram", "!explorerResourceIsFolder", "navigation@98"],
      ["graph-it-live.showFolderDiagram", "explorerResourceIsFolder", "navigation@98"],
    ]);
    for (const id of ["graph-it-live.showDiagram", "graph-it-live.showFlowDiagram", "graph-it-live.showFolderDiagram"]) expect(contributed).toContain(id);
  });

  it("offers Show Dependency Graph in the editor title for exactly the supported source files", () => {
    const entry = pkg.contributes.menus["editor/title"].find((item) => item.command === "graph-it-live.showGraph");
    expect(entry?.when).toBe(`resourceExtname =~ /${SUPPORTED_SOURCE_FILE_REGEX.source}/`);
  });
});
