/**
 * Auto-imports a project declares in the files its tools generate: Nuxt `.nuxt/imports.d.ts` and
 * `.nuxt/components.d.ts`, unplugin-auto-import `auto-imports.d.ts`, unplugin-vue-components `components.d.ts`
 * (or the `dts` paths its Vite config names). In a file of that project, a name they declare binds as an import of
 * that export from that file; a name they do not declare is never guessed.
 *
 * NO vscode imports — this module is VS Code-agnostic.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "@/shared/path";
import { isPathWithinRootCanonical } from "@/shared/pathSecurity";

/** What a declared name binds: the declaration file, the specifier written there and the export it names. */
export interface AutoImport {
  from: string;
  specifier: string;
  imported: string;
}

/** A declaration file a project's tooling should have generated, and how to generate it. */
export interface MissingAutoImports {
  source: string;
  hint: string;
}

export interface AutoImportProject {
  /** Normalized folder holding the project's package.json. */
  root: string;
  /** Normalized declaration files read. */
  sources: string[];
  names: ReadonlyMap<string, AutoImport>;
  /** Hash of the declaration files read; empty when there is none. */
  hash: string;
  missing: MissingAutoImports[];
}

/** Generated declaration files, relative to the project folder. */
const DECLARATION_FILES = [".nuxt/imports.d.ts", ".nuxt/components.d.ts", "auto-imports.d.ts", "src/auto-imports.d.ts", "components.d.ts", "src/components.d.ts"];
/** A Nuxt app has one; a package that only depends on nuxt (a module, a layer's tooling) generates no `.nuxt`. */
const NUXT_CONFIGS = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.mts"];
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
/** Vite plugins writing a declaration file, with the file they write without a `dts` option. */
const DTS_PLUGINS = [
  { name: "unplugin-auto-import", file: "auto-imports.d.ts" },
  { name: "unplugin-vue-components", file: "components.d.ts" },
];
const OUTSIDE_HINT = "outside the workspace: not read";
const VITE_HINT = "start or build the Vite app once to generate it";

/**
 * `useX: typeof import('./src/x')['useX']`, `useX: typeof import('./src/x').useX` (unplugin-auto-import 19+),
 * `'Foo': LazyComponent<typeof import("../c/Foo.vue")['default']>`.
 */
const TYPEOF_IMPORT = /([A-Za-z_$][\w$]*)['"]?\??:\s*(?:[\w$.]+<)?typeof import\(['"]([^'"]+)['"]\)(?:\.|\[['"])([\w$]+)/g;
/** `export { useX, default as useY } from '../composables/x'` (Nuxt); `export type { … }` binds no value. */
const EXPORT_FROM = /export \{([^}]*)\} from ['"]([^'"]+)['"]/g;
/** `dts: 'src/auto-imports.d.ts'` in a Vite config. */
const DTS_OPTION = /\bdts:\s*['"]([^'"]+)['"]/g;

/**
 * The names a declaration file binds, added to `names` (a name already bound keeps its first declaration). A package
 * entry (`ref` from `'vue'`) is kept: it binds the name to no workspace file, so no homonym is guessed for it.
 */
export function readDeclarations(content: string, from: string, names: Map<string, AutoImport>): void {
  const add = (local: string, specifier: string, imported: string) => {
    if (names.has(local)) return;
    // An absolute specifier (some Nuxt versions) is made relative, as the resolver reads it from `from`.
    const relative = path.isAbsolute(specifier) ? `./${normalizePath(path.relative(path.dirname(from), specifier))}` : specifier;
    names.set(local, { from, specifier: relative, imported });
  };
  for (const [, local, specifier, member] of content.matchAll(TYPEOF_IMPORT)) add(local, specifier, member);
  for (const [, list, specifier] of content.matchAll(EXPORT_FROM)) {
    for (const item of list.split(",")) {
      const [imported, local = imported] = item.trim().split(/\s+as\s+/);
      if (imported) add(local, specifier, imported);
    }
  }
}

/** Whether a workspace-relative path is an auto-import declaration, or the `.nuxt` folder holding two, for a file watcher. */
export function isAutoImportDeclaration(relativePath: string): boolean {
  const parts = normalizePath(relativePath).split("/");
  const name = parts.at(-1);
  if (name === ".nuxt") return true;
  if (parts.at(-2) === ".nuxt") return name === "imports.d.ts" || name === "components.d.ts";
  return name === "auto-imports.d.ts" || name === "components.d.ts";
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function dependsOn(manifest: string | null, name: string): boolean {
  try {
    const json = JSON.parse(manifest ?? "{}") as Record<string, Record<string, unknown> | undefined>;
    return Boolean(json.dependencies?.[name] ?? json.devDependencies?.[name]);
  } catch {
    return false;
  }
}

/** Declarations a Nuxt app, or a Vite plugin without a `dts` path, should have generated and that are absent. */
function unconfiguredMissing(root: string, viteConfig: string, configured: boolean, sources: string[]): MissingAutoImports[] {
  const missing: MissingAutoImports[] = [];
  const nuxtApp = NUXT_CONFIGS.some(name => fs.existsSync(path.join(root, name))) && dependsOn(readText(path.join(root, "package.json")), "nuxt");
  if (nuxtApp && !sources.some(source => source.endsWith("/.nuxt/imports.d.ts"))) {
    missing.push({ source: ".nuxt/imports.d.ts", hint: "run nuxi prepare (or nuxi dev) to generate it" });
  }
  if (configured || /\bdts:\s*false\b/.test(viteConfig)) return missing;
  for (const plugin of DTS_PLUGINS) {
    if (viteConfig.includes(plugin.name) && !sources.some(source => path.basename(source) === plugin.file)) {
      missing.push({ source: plugin.file, hint: VITE_HINT });
    }
  }
  return missing;
}

/**
 * Auto-imports by project (each folder with a package.json), read once per instance.
 * shortcut: a `dts` path set in a Nuxt or Vite config built at runtime (not a string literal) is not read; upgrade
 * if a project names one that way.
 */
export class AutoImports {
  private readonly workspaceRoot: string;
  /** Folder -> its project folder, or null outside any project. */
  private readonly roots = new Map<string, string | null>();
  private readonly projects = new Map<string, AutoImportProject>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /** The project of a file, with what its declarations bind; null outside any project of the workspace. */
  forFile(filePath: string): AutoImportProject | null {
    const root = this.projectRoot(path.dirname(path.resolve(filePath)));
    return root === null ? null : this.project(root);
  }

  /** The projects holding these files, each once. */
  projectsOf(files: Iterable<string>): AutoImportProject[] {
    const found = new Map<string, AutoImportProject>();
    for (const file of files) {
      const project = this.forFile(file);
      if (project) found.set(project.root, project);
    }
    return [...found.values()];
  }

  private projectRoot(dir: string): string | null {
    const known = this.roots.get(dir);
    if (known !== undefined) return known;
    let root: string | null = null;
    if (isPathWithinRootCanonical(dir, this.workspaceRoot)) {
      const parent = path.dirname(dir);
      const atTop = dir === this.workspaceRoot || parent === dir;
      if (fs.existsSync(path.join(dir, "package.json"))) root = dir;
      else if (!atTop) root = this.projectRoot(parent);
    }
    this.roots.set(dir, root);
    return root;
  }

  private project(root: string): AutoImportProject {
    const key = normalizePath(root);
    const cached = this.projects.get(key);
    if (cached) return cached;
    const viteConfig = VITE_CONFIGS.map(name => readText(path.join(root, name))).find(text => text !== null) ?? "";
    const configured = [...viteConfig.matchAll(DTS_OPTION)].map(([, file]) => normalizePath(path.normalize(file)));
    const names = new Map<string, AutoImport>();
    const hash = createHash("sha256");
    const sources: string[] = [];
    const missing: MissingAutoImports[] = [];
    for (const relative of [...new Set([...DECLARATION_FILES, ...configured])]) {
      const file = path.join(root, relative);
      // A config's `dts` may point anywhere: only a file of the workspace is read (CWE-22).
      const inside = isPathWithinRootCanonical(file, this.workspaceRoot);
      const content = inside ? readText(file) : null;
      if (content === null) {
        if (configured.includes(relative)) missing.push({ source: relative, hint: inside ? VITE_HINT : OUTSIDE_HINT });
        continue;
      }
      const source = normalizePath(file);
      sources.push(source);
      hash.update(`${source}\0${content}\0`);
      readDeclarations(content, source, names);
    }
    missing.push(...unconfiguredMissing(root, viteConfig, configured.length > 0, sources));
    const project: AutoImportProject = { root: key, sources, names, hash: sources.length > 0 ? hash.digest("hex") : "", missing };
    this.projects.set(key, project);
    return project;
  }
}
