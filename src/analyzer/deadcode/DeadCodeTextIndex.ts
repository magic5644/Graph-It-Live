import fs from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../../shared/concurrency";
import { getRelativePath, normalizePath } from "../../shared/path";
import type { FileReader } from "../FileReader";
import { SourceFileCollector } from "../SourceFileCollector";
import { isSupportedSourceFile } from "../SourceFileFilters";
import { parseTsConfig } from "../utils/tsconfig";
import { packageFrameworks } from "./frameworkRoutes";
import { globToRegexSource } from "../graph-context/FileScopeMatcher";
import { SUPPORTED_FILE_EXTENSIONS } from "../../shared/constants";
import { getLogger } from "../../shared/logger";
import {
  deployManifestReferences,
  findDynamicLoads,
  CI_DEFINITION_DIRS,
  isDeployManifest,
  isScriptRunner,
  isTestFile,
  mayLoadDynamically,
  readsComputedAttribute,
  rustQualifiedPaths,
  writtenSourcePaths,
  writtenWorkingDirs,
  htmlSourcePaths,
  templatedSourceNames,
  expandBraces,
  viteGlobs,
  urlImports,
  type DynamicLoad,
  type ViteGlob,
} from "./deadCodeConfidence";
import {
  collectDeclaredEntryPoints,
  deepImportablePackageName,
  deepSpecifierPackages,
  MANIFEST_FILE_NAMES,
  pythonAllNames,
  rustAttributedFunctions,
  rustPublicModules,
  type BuildLayout,
  type DeclaredEntryPoints,
  type Manifest,
} from "./declaredEntryPoints";

const log = getLogger("DeadCodeTextIndex");

const READ_CONCURRENCY = 16;
const RUST_FILE = /\.rs$/i;
const PYTHON_FILE = /\.pyi?$/i;
const JS_FAMILY_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const YAML_FILE = /\.ya?ml$/i;
const HTML_FILE = /\.html?$/i;

interface FileFacts {
  mtimeMs: number;
  size: number;
  loads: DynamicLoad[];
  rustPaths: string[];
  rustTokens: string[];
  readsComputedAttribute: boolean;
  /** Manifests only: their text, parsed once per scan */
  manifestText?: string;
  pythonAll: string[];
  rustPubMods: string[];
  rustAttributed: Array<{ name: string; attribute: string }>;
  /** Deployment manifests only: their `module.name` pairs (deployManifestReferences) */
  deployRefs: string[];
  /** JS/TS/Vue sources: the package names heading a quoted deep specifier (deepSpecifierPackages) */
  deepSpecifiers: string[];
  /** Non-test files: the source paths they write (writtenSourcePaths) */
  writtenPaths: string[];
  /** Files writing paths: the folders their commands run in (writtenWorkingDirs) */
  workingDirs: string[];
  /** Non-test JS/TS/Vue/Svelte sources: their `import.meta.glob` calls (viteGlobs) */
  globs: ViteGlob[];
  /** Non-test JS/TS/Vue/Svelte sources: their `new URL('./x', import.meta.url)` specifiers (urlImports) */
  urls: string[];
  /** Non-test JS/TS sources: the file names they build at run time (templatedSourceNames) */
  nameTemplates: string[];
}

const NO_FACTS: Omit<FileFacts, "mtimeMs" | "size"> = {
  loads: [], rustPaths: [], rustTokens: [], readsComputedAttribute: false, pythonAll: [], rustPubMods: [], rustAttributed: [],
  deployRefs: [], deepSpecifiers: [], writtenPaths: [], workingDirs: [], globs: [], urls: [], nameTemplates: [],
};

/** What the dead-code scan reads as text across the workspace. */
export interface WorkspaceTextFacts {
  /** Modules loaded by computed path */
  loads: DynamicLoad[];
  /** Every `qualifier::name` pair written in a Rust file */
  rustPaths: ReadonlySet<string>;
  /** How many Rust files write each identifier */
  rustTokenFiles: ReadonlyMap<string, number>;
  /** Python files that read attributes by computed name (`getattr(mod, name)`), absolute normalized */
  computedAttributeReaders: ReadonlySet<string>;
  /** What the language manifests declare as used (`declaredEntryPoints.ts`) */
  entryPoints: DeclaredEntryPoints;
  /** `module.name` pairs written in container and deployment manifests (Dockerfile, serverless, SAM...) */
  deployReferences: ReadonlySet<string>;
  /**
   * Folder of every package.json (absolute, normalized) → whether it is a published package with no `exports` map
   * that the workspace imports by deep path (`<name>/<file>`)
   */
  packageDeepImport: ReadonlyMap<string, boolean>;
  /**
   * Source file (absolute, normalized) → the first non-test file, workspace-relative, that writes its path: a bundler
   * entry, a package.json script, a Dockerfile command
   */
  namedPaths: ReadonlyMap<string, string>;
  /** Folder of every package.json (absolute, normalized) → the frameworks it uses (frameworkRoutes.ts) */
  frameworksByPackage: ReadonlyMap<string, readonly number[]>;
}

/**
 * Facts the dead-code scan reads from the text of every workspace file, no parse: modules loaded by computed
 * path, and Rust identifiers and qualified paths. The Rust symbol analysis follows calls through `use` and
 * `mod` only: a type used in a signature, `Type::new()`, a nested grouped `use` or a path such as
 * `complete::bash::generate()` from a file that never imports bash.rs leave no edge, so the scan keeps a Rust
 * export whose name another Rust file writes at medium confidence at most.
 * A file is read again only when its mtime or size changed, so a single-file check does not reread the workspace.
 */
export class DeadCodeTextIndex {
  private rootDir = "";
  private perFile = new Map<string, FileFacts>();

  constructor(private readonly fileReader: FileReader) {}

  async collect(rootDir: string, excludeNodeModules: boolean): Promise<WorkspaceTextFacts> {
    const root = normalizePath(path.resolve(rootDir));
    // Evidence paths are relative to this root: another root starts over.
    if (root !== this.rootDir) {
      this.rootDir = root;
      this.perFile = new Map();
    }
    const isManifest = (name: string): boolean => MANIFEST_FILE_NAMES.has(name);
    // One walk for the source files and the manifests next to them.
    const collector = new SourceFileCollector({ excludeNodeModules });
    const walked = (await collector.collectFiles(rootDir, (name) => isSupportedSourceFile(name) || isManifest(name) || isDeployManifest(name) || isScriptRunner(name) || HTML_FILE.test(name))).map(normalizePath);
    // The walk skips dot-folders: CI definitions there run scripts by path (`node scripts/x.mjs`).
    const ciFiles = new Set((await Promise.all(CI_DEFINITION_DIRS.map((dir) => collector.collectFiles(path.join(rootDir, dir), (name) => YAML_FILE.test(name))))).flat().map(normalizePath));
    const next = new Map<string, FileFacts>();
    await mapWithConcurrency([...walked, ...ciFiles], READ_CONCURRENCY, async (file) => {
      const entry = await this.factsOf(file, isManifest(path.posix.basename(file)), ciFiles.has(file));
      if (entry) next.set(file, entry);
    });
    this.perFile = next;
    const files = walked.filter((file) => isSupportedSourceFile(file));
    const packageDirs = walked.filter((file) => path.posix.basename(file) === "package.json").map((file) => path.posix.dirname(file));
    const present = files.flatMap((file) => next.get(file) ?? []);
    const computedAttributeReaders = new Set(files.filter((file) => next.get(file)?.readsComputedAttribute));
    const rustTokenFiles = new Map<string, number>();
    for (const token of present.flatMap((entry) => entry.rustTokens)) rustTokenFiles.set(token, (rustTokenFiles.get(token) ?? 0) + 1);
    return {
      loads: present.flatMap((entry) => entry.loads),
      rustPaths: new Set(present.flatMap((entry) => entry.rustPaths)),
      rustTokenFiles,
      computedAttributeReaders,
      entryPoints: await this.entryPoints(root, files, next),
      deployReferences: new Set([...next.values()].flatMap((entry) => entry.deployRefs)),
      packageDeepImport: packageDeepImport(next, new Set(present.flatMap((entry) => entry.deepSpecifiers))),
      namedPaths: bundlerLoadedPaths(root, next, files, packageDirs, namedPaths(root, next, new Set(files))),
      frameworksByPackage: new Map(packageDirs.map((dir) => [dir, packageFrameworks(next.get(`${dir}/package.json`)?.manifestText ?? "")])),
    };
  }

  private async entryPoints(root: string, files: string[], facts: ReadonlyMap<string, FileFacts>): Promise<DeclaredEntryPoints> {
    const manifests = await Promise.all(
      [...facts].filter(([, entry]) => entry.manifestText !== undefined).map(async ([file, entry]): Promise<Manifest> => ({
        file,
        text: entry.manifestText ?? "",
        ...(path.posix.basename(file) === "package.json" ? { layout: await buildLayout(path.posix.dirname(file)) } : {}),
      }))
    );
    const byFile = <T>(pick: (entry: FileFacts) => T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const file of files) {
        const entry = facts.get(file);
        const values = entry ? pick(entry) : [];
        if (values.length > 0) map.set(file, values);
      }
      return map;
    };
    const { entryPoints, warnings } = collectDeclaredEntryPoints({
      rootDir: root,
      files: new Set(files),
      manifests,
      pythonAll: byFile((entry) => entry.pythonAll),
      rustPubMods: byFile((entry) => entry.rustPubMods),
      rustAttributed: byFile((entry) => entry.rustAttributed),
    });
    for (const warning of warnings) log.warn(`Dead-code scan: ${warning}`);
    return entryPoints;
  }

  /** `ciDefinition`: a CI file of a dot-folder, read for the paths it writes only (its `steps.x` keys are no handlers). */
  private async factsOf(file: string, manifest: boolean, ciDefinition: boolean): Promise<FileFacts | null> {
    try {
      const { mtimeMs, size } = await fs.stat(file);
      const cached = this.perFile.get(file);
      if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached;
      // No size cap: a large file's loads and names count as much as any other's (read once, then cached).
      const content = await this.fileReader.readFile(file, { maxSize: Number.POSITIVE_INFINITY });
      return { mtimeMs, size, ...this.contentFacts(file, content, manifest, ciDefinition) };
    } catch {
      // Deleted or unreadable: it holds no code the scan could miss.
      return null;
    }
  }

  private contentFacts(file: string, content: string, manifest: boolean, ciDefinition: boolean): Omit<FileFacts, "mtimeMs" | "size"> {
    const test = isTestFile(getRelativePath(file, this.rootDir));
    if (ciDefinition) return { ...NO_FACTS, ...writtenFacts(content) };
    if (HTML_FILE.test(file)) return { ...NO_FACTS, writtenPaths: test ? [] : htmlSourcePaths(content) };
    const loads = mayLoadDynamically(content) ? findDynamicLoads(file, getRelativePath(file, this.rootDir), content, this.rootDir) : [];
    const rust = RUST_FILE.test(file);
    return {
      loads,
      rustPaths: rust ? rustQualifiedPaths(content) : [],
      rustTokens: rust ? [...new Set(content.match(/\b[A-Za-z_]\w*\b/g))] : [],
      readsComputedAttribute: PYTHON_FILE.test(file) && readsComputedAttribute(content),
      ...(manifest ? { manifestText: content } : {}),
      pythonAll: path.posix.basename(file) === "__init__.py" ? pythonAllNames(content) : [],
      rustPubMods: rust ? rustPublicModules(content) : [],
      rustAttributed: rust ? rustAttributedFunctions(content) : [],
      deployRefs: isDeployManifest(path.posix.basename(file)) ? deployManifestReferences(content) : [],
      deepSpecifiers: JS_FAMILY_FILE.test(file) ? deepSpecifierPackages(content) : [],
      ...bundlerLoads(file, content, test),
      // Tests write fixture paths by design: they run nothing by name.
      ...(test ? { writtenPaths: [], workingDirs: [] } : writtenFacts(content)),
    };
  }
}

/** What a bundler loads from a non-test JS-family source besides its imports: `import.meta.glob`, `new URL(..., import.meta.url)`. */
function bundlerLoads(file: string, content: string, test: boolean): Pick<FileFacts, "globs" | "urls" | "nameTemplates"> {
  if (test || !JS_FAMILY_FILE.test(file)) return { globs: [], urls: [], nameTemplates: [] };
  const meta = content.includes("import.meta.");
  return { globs: meta ? viteGlobs(content) : [], urls: meta ? urlImports(content) : [], nameTemplates: content.includes("${") ? templatedSourceNames(content) : [] };
}

function writtenFacts(content: string): Pick<FileFacts, "writtenPaths" | "workingDirs"> {
  const writtenPaths = writtenSourcePaths(content);
  return { writtenPaths, workingDirs: writtenPaths.length > 0 ? writtenWorkingDirs(content) : [] };
}

/**
 * Each source file whose path another file writes, resolved from the workspace root, from the writer's folder, or
 * from a folder its commands run in (`working-directory`, `cd`), itself relative to the root or to the writer.
 * shortcut: any folder of the writer applies to any path it writes; it only keeps more files alive.
 */
function namedPaths(root: string, facts: ReadonlyMap<string, FileFacts>, files: ReadonlySet<string>): Map<string, string> {
  const named = new Map<string, string>();
  for (const [writer, entry] of facts) {
    const near = [root, path.posix.dirname(writer)];
    const bases = [...near, ...entry.workingDirs.flatMap((dir) => near.map((from) => path.posix.join(from, dir)))];
    for (const written of entry.writtenPaths) {
      for (const base of bases) {
        const file = normalizePath(path.resolve(base, written));
        if (file !== writer && files.has(file) && !named.has(file)) named.set(file, getRelativePath(writer, root));
      }
    }
  }
  return named;
}

/**
 * Adds to `named` the files a source loads by a path its imports do not show (globTargets, urlTarget, templateTargets),
 * named after that source.
 */
function bundlerLoadedPaths(
  root: string,
  facts: ReadonlyMap<string, FileFacts>,
  files: readonly string[],
  packageDirs: readonly string[],
  named: Map<string, string>,
): Map<string, string> {
  const fileSet = new Set(files);
  const viteRoot = (file: string): string => packageDirs.filter((dir) => file.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0] ?? root;
  for (const [writer, entry] of facts) {
    const loaded = [
      ...entry.globs.flatMap((glob) => globTargets(glob, writer, viteRoot(writer), files)),
      ...entry.urls.flatMap((url) => urlTarget(url, writer, fileSet) ?? []),
      ...templateTargets(entry.nameTemplates, viteRoot(writer), files),
    ];
    for (const file of loaded) if (file !== writer && !named.has(file)) named.set(file, getRelativePath(writer, root));
  }
  return named;
}

/**
 * The files an `import.meta.glob` (Vite) of `writer` matches: patterns relative to the file or to its `base` option, `/`
 * from `viteRoot`, `!` ones taking files out (a negated folder with what it holds); aliased patterns (`@/x/*`) left out.
 */
function globTargets(glob: ViteGlob, writer: string, viteRoot: string, files: readonly string[]): string[] {
  const from = glob.base ? path.posix.join(path.posix.dirname(writer), glob.base) : path.posix.dirname(writer);
  const compile = (pattern: string, under = ""): RegExp[] => expandBraces(pattern).flatMap((expanded) => {
    if (!expanded.startsWith(".") && !expanded.startsWith("/")) return [];
    const absolute = expanded.startsWith("/") ? path.posix.join(viteRoot, expanded) : path.posix.join(from, expanded);
    return [new RegExp(`^${globToRegexSource(absolute)}${under}$`)];
  });
  const include = glob.patterns.filter((pattern) => !pattern.startsWith("!")).flatMap((pattern) => compile(pattern));
  // `!**/node_modules` excludes anywhere: compile it as relative to the same folder.
  const exclude = glob.patterns.filter((pattern) => pattern.startsWith("!")).flatMap((pattern) => compile(pattern.slice(1).replace(/^(?![./])/, "./"), "(?:/.*)?"));
  return files.filter((file) => include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file)));
}

/**
 * The files of the writer's package whose name matches a name it builds at run time (`config.*.ts`).
 * shortcut: the folder the name is joined to is not followed, any folder of the package matches; it only keeps files alive.
 */
function templateTargets(names: readonly string[], packageDir: string, files: readonly string[]): string[] {
  if (names.length === 0) return [];
  const patterns = names.map((name) => new RegExp(`^${globToRegexSource(name)}$`));
  return files.filter((file) => file.startsWith(`${packageDir}/`) && patterns.some((re) => re.test(path.posix.basename(file))));
}

/** The file `new URL(url, import.meta.url)` of `writer` loads, resolved like an import: as written, with an extension, or a folder's index. */
function urlTarget(url: string, writer: string, files: ReadonlySet<string>): string | undefined {
  const base = path.posix.join(path.posix.dirname(writer), url);
  return [base, ...SUPPORTED_FILE_EXTENSIONS.flatMap((ext) => [base + ext, `${base}/index${ext}`])].find((candidate) => files.has(candidate));
}

function packageDeepImport(facts: ReadonlyMap<string, FileFacts>, deepNames: ReadonlySet<string>): Map<string, boolean> {
  const packages = new Map<string, boolean>();
  for (const [file, entry] of facts) {
    if (entry.manifestText === undefined || path.posix.basename(file) !== "package.json") continue;
    const name = deepImportablePackageName(entry.manifestText);
    packages.set(path.posix.dirname(file), name !== undefined && deepNames.has(name));
  }
  return packages;
}

/**
 * `outDir` / `rootDir` of the tsconfig.json next to a package.json (absolute, normalized); empty when there is none.
 * shortcut: values inherited through `extends` are not read (the output then maps to nothing: an item reported, never
 * hidden); follow `resolveExtendsTargets` if monorepos need it.
 */
async function buildLayout(packageDir: string): Promise<BuildLayout> {
  const file = path.posix.join(packageDir, "tsconfig.json");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  const options: unknown = parseTsConfig(file, text)?.compilerOptions;
  const layout: BuildLayout = {};
  if (typeof options !== "object" || options === null) return layout;
  for (const key of ["outDir", "rootDir"] as const) {
    const value: unknown = (options as Record<string, unknown>)[key];
    if (typeof value === "string") layout[key] = normalizePath(path.resolve(packageDir, value));
  }
  return layout;
}
