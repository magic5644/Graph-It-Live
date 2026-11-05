import fs from 'node:fs/promises';
import path from 'node:path';
import { ts } from 'ts-morph';
import { normalizePath } from '@/shared/path';
import type { GraphData } from '@/shared/graph-types';
import { mapWithConcurrency } from '@/shared/concurrency';
import { PathResolver } from './utils/PathResolver';
import { DEFAULT_ONLY, findDeclaration, type DeclarationReads } from './utils/declarations';

interface ReactComponent { name: string; startLine: number }
interface ReactImport { moduleSpecifier: string; name: string }
type ImportBinding = ReactImport;
interface ReactIdentityEntry { filePath: string; identity: ReactIdentity }
export interface ReactIdentity {
  components: ReactComponent[];
  jsxImports: ReactImport[];
  isReact: boolean;
  eligible: boolean;
}

const REACT_MODULE = /^(?:react|react-dom)(?:\/|$)/;
const OTHER_JSX_MODULE = /^(?:preact|solid-js)(?:\/|$)/;
/** `react` itself or a React-based runtime such as `@emotion/react`. */
const REACT_RUNTIME = /^(?:@[^/]+\/)?react$/;
/** Without one of these words a file can be neither React nor a competing JSX runtime. */
const RUNTIME_HINT = /react|solid-js|@jsxImportSource/;
const IDENTITY_CACHE_LIMIT = 20_000;
const identityCache = new Map<string, { mtimeMs: number; size: number; runtime?: string; identity: ReactIdentity }>();
const COMPONENT_FACTORY = /^(?:memo|forwardRef|lazy)$/;
const JS_TS_FILE = /\.[cm]?[jt]sx?$/i;
/** TypeScript reads `<X>` as a type assertion in .ts, .mts and .cts files: they cannot render JSX. */
const NO_JSX_FILE = /\.[cm]?ts$/i;

function importBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { moduleSpecifier, name: 'default' });
    addNamedBindings(bindings, moduleSpecifier, clause?.namedBindings);
  }
  return bindings;
}

function addNamedBindings(bindings: Map<string, ImportBinding>, moduleSpecifier: string, named: ts.NamedImportBindings | undefined): void {
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    bindings.set(named.name.text, { moduleSpecifier, name: '*' });
    return;
  }
  for (const entry of named.elements) {
    if (!entry.isTypeOnly) bindings.set(entry.name.text, { moduleSpecifier, name: (entry.propertyName ?? entry.name).text });
  }
}

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(entry => ts.isOmittedExpression(entry) ? [] : boundNames(entry.name));
}

function statementNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name));
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) return [statement.name.text];
  return [];
}

function isShadowed(node: ts.Node, name: string, declaration?: ts.Node): boolean {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => boundNames(parameter.name).includes(name))) return true;
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const bindings = scope.statements.filter(statement => statement !== declaration && !containsNode(statement, declaration));
      if (bindings.some(statement => statementNames(statement).includes(name))) return true;
    }
  }
  return false;
}

function containsNode(parent: ts.Node, node: ts.Node | undefined): boolean {
  return node !== undefined && node.pos >= parent.pos && node.end <= parent.end;
}

function hasJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
  return ts.forEachChild(node, hasJsx) ?? false;
}

function rendersJsx(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false;
  if (!ts.isBlock(body)) return hasJsx(body);
  const visit = (node: ts.Node): boolean => {
    if (ts.isReturnStatement(node)) return node.expression ? hasJsx(node.expression) : false;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(body);
}

function isReactFactory(node: ts.Expression | undefined, bindings: Map<string, ImportBinding>): boolean {
  if (!node || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    const binding = bindings.get(callee.text);
    return binding?.moduleSpecifier === 'react' && COMPONENT_FACTORY.test(binding.name) && !isShadowed(callee, callee.text);
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || !COMPONENT_FACTORY.test(callee.name.text)) return false;
  const binding = bindings.get(callee.expression.text);
  return binding?.moduleSpecifier === 'react' && ['default', '*'].includes(binding.name) && !isShadowed(callee, callee.expression.text);
}

function componentCandidate(node: ts.Node, bindings: Map<string, ImportBinding>): { name: string; node: ts.Node; proven: boolean } | undefined {
  if (ts.isFunctionDeclaration(node)) return { name: node.name?.text ?? 'default', node, proven: rendersJsx(node.body) };
  if (ts.isClassDeclaration(node)) {
    const render = node.members.find(member => ts.isMethodDeclaration(member) && member.name.getText() === 'render');
    return { name: node.name?.text ?? 'default', node, proven: Boolean(render && ts.isMethodDeclaration(render) && rendersJsx(render.body)) };
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  const value = node.initializer;
  const callable = value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
  const factory = isReactFactory(value, bindings);
  if (!callable && !factory) return undefined;
  return { name: node.name.text, node, proven: factory || Boolean(callable && rendersJsx(value.body)) };
}

function jsxTagBinding(tag: ts.JsxTagNameExpression, bindings: Map<string, ImportBinding>): ReactImport | undefined {
  if (ts.isIdentifier(tag)) return isShadowed(tag, tag.text) ? undefined : bindings.get(tag.text);
  if (!ts.isPropertyAccessExpression(tag) || !ts.isIdentifier(tag.expression)) return undefined;
  const binding = bindings.get(tag.expression.text);
  return binding?.name === '*' && !isShadowed(tag, tag.expression.text) ? { moduleSpecifier: binding.moduleSpecifier, name: tag.name.text } : undefined;
}

/** Static component evidence only; a JSX extension or an arbitrary callback is never React proof. */
export function analyzeReactIdentity(filePath: string, source: string, jsxImportSource?: string): ReactIdentity {
  const empty: ReactIdentity = { components: [], jsxImports: [], isReact: false, eligible: false };
  if (!JS_TS_FILE.test(filePath)) return empty;
  if (!jsxImportSource && !RUNTIME_HINT.test(source)) return { ...empty, eligible: true };
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const bindings = importBindings(sourceFile);
  const comments = (ts.getLeadingCommentRanges(source, 0) ?? []).map(range => source.slice(range.pos, range.end)).join('\n');
  const runtime = /@jsxImportSource\s+([^\s*]+)/.exec(comments)?.[1] ?? jsxImportSource;
  const modules = [...bindings.values()].map(binding => binding.moduleSpecifier);
  if ([runtime ?? '', ...modules].some(module => OTHER_JSX_MODULE.test(module))) return empty;
  const isReact = REACT_RUNTIME.test(runtime ?? '') || modules.some(module => REACT_MODULE.test(module));
  const result: ReactIdentity = { ...empty, eligible: true, isReact };
  if (!isReact) return result;
  const candidates: Array<NonNullable<ReturnType<typeof componentCandidate>>> = [];
  const tags: ts.JsxTagNameExpression[] = [];
  const visit = (node: ts.Node): void => {
    const candidate = componentCandidate(node, bindings);
    if (candidate) candidates.push(candidate);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.push(node.tagName);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const tag of tags) {
    if (!/^[A-Z]/.test(tag.getText())) continue;
    const imported = jsxTagBinding(tag, bindings);
    if (imported) result.jsxImports.push(imported);
    if (!ts.isIdentifier(tag)) continue;
    const local = candidates.filter(candidate => candidate.name === tag.text);
    if (local.length === 1 && !isShadowed(tag, tag.text, local[0].node)) local[0].proven = true;
  }
  // JSX treats lowercase tags as intrinsic elements, so a lowercase render helper is not a component.
  result.components = candidates.filter(candidate => candidate.proven && /^(?:[A-Z]|default$)/.test(candidate.name)).map(candidate => ({
    name: candidate.name,
    startLine: sourceFile.getLineAndCharacterOfPosition(candidate.node.getStart(sourceFile)).line,
  }));
  return result;
}

/**
 * Explicit JSX runtime: `jsxImportSource`, else `react` for the React automatic runtime (`react-jsx`/`react-jsxdev`).
 * Absence leaves JSX-only files unclassified.
 * shortcut: reads the root tsconfig.json only (no `extends`, nested projects or jsconfig.json), upgrade when per-project runtimes matter.
 */
export async function readReactJsxImportSource(workspaceRoot: string): Promise<string | undefined> {
  try {
    const configPath = path.join(workspaceRoot, 'tsconfig.json');
    const content = await fs.readFile(configPath, 'utf8');
    const options: unknown = ts.parseConfigFileTextToJson(configPath, content).config?.compilerOptions;
    if (!options || typeof options !== 'object') return undefined;
    const { jsx, jsxImportSource } = options as { jsx?: unknown; jsxImportSource?: unknown };
    if (typeof jsxImportSource === 'string') return jsxImportSource;
    return typeof jsx === 'string' && /^react-jsx(?:dev)?$/i.test(jsx) ? 'react' : undefined;
  } catch { return undefined; }
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Recomputed per graph request, so removed JSX/imports cannot leave stale framework badges. */
async function graphReactEvidence(graphPaths: readonly string[], referencingPaths: readonly string[], workspaceRoot: string) {
  // Importers count only for the JSX they render: one that cannot hold JSX is not read.
  const filePaths = [...graphPaths, ...referencingPaths.filter(filePath => !NO_JSX_FILE.test(filePath))];
  const root = normalizePath(path.resolve(workspaceRoot));
  const realRoot = await fs.realpath(root).catch(() => root);
  const jsxImportSource = await readReactJsxImportSource(root);
  const reads: DeclarationReads = new Map();
  const resolver = new PathResolver(undefined, true, root);
  const paths = [...new Set(filePaths.map(filePath => normalizePath(path.resolve(filePath))))];
  const entries = await mapWithConcurrency(paths, 8, async filePath => readIdentityEntry(filePath, realRoot, jsxImportSource, reads));
  const byPath = new Map(entries.flatMap(entry => entry ? [[entry.filePath, entry] as const] : []));
  const targets = new Map<string, Set<string>>();
  const imported = entries.flatMap(entry => entry?.identity.jsxImports.map(reference => ({ source: entry.filePath, reference })) ?? []);
  await mapWithConcurrency(imported, 8, async ({ source, reference }) => {
    const target = await resolver.resolve(source, reference.moduleSpecifier).catch(() => null);
    const realTarget = target && await fs.realpath(target).catch(() => null);
    if (!realTarget || !isInside(realRoot, realTarget)) return;
    const declaration = await findDeclaration(target, reference.name, resolver, reads);
    if (!declaration || declaration === DEFAULT_ONLY) return;
    if (!byPath.get(declaration.filePath)?.identity.eligible) return;
    const key = normalizePath(declaration.filePath);
    const names = targets.get(key) ?? new Set<string>();
    names.add(declaration.name);
    targets.set(key, names);
  });
  return { entries, targets };
}

async function readIdentityEntry(filePath: string, root: string, runtime: string | undefined, reads: DeclarationReads): Promise<ReactIdentityEntry | undefined> {
  if (!JS_TS_FILE.test(filePath)) return undefined;
  try {
    const realPath = await fs.realpath(filePath);
    if (!isInside(root, realPath)) return undefined;
    const { mtimeMs, size } = await fs.stat(realPath);
    const cached = identityCache.get(filePath);
    // Graph refreshes re-read every node and importer: an unchanged file keeps its parsed evidence.
    if (cached?.mtimeMs === mtimeMs && cached.size === size && cached.runtime === runtime) return { filePath, identity: cached.identity };
    const source = await fs.readFile(filePath, 'utf8');
    reads.set(filePath, Promise.resolve(source));
    const identity = analyzeReactIdentity(filePath, source, runtime);
    if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
    identityCache.set(filePath, { mtimeMs, size, runtime, identity });
    return { filePath, identity };
  } catch { return undefined; }
}

/** Recomputed per graph request, so removed JSX/imports cannot leave stale framework badges. */
export async function enrichReactFramework(graphData: GraphData, workspaceRoot: string, referencingPaths: readonly string[] = []): Promise<void> {
  if (!workspaceRoot) return;
  const { entries, targets } = await graphReactEvidence(graphData.nodes, referencingPaths, workspaceRoot);
  const proven = new Set(entries.flatMap(entry => entry?.identity.components.length ? [entry.filePath] : []));
  for (const filePath of graphData.nodes) {
    const key = normalizePath(filePath);
    const metadata = graphData.nodeMetadata?.[key];
    if (!metadata) continue;
    delete metadata.framework;
    if (proven.has(key) || targets.has(key)) metadata.framework = 'react';
  }
}

/** JSX-only targets are components too; callbacks in the same import remain ordinary symbols. */
export async function enrichReactSymbols(
  symbols: Array<{ name: string; line: number; framework?: 'react' }>,
  filePath: string,
  referencingPaths: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  if (!workspaceRoot) return;
  const key = normalizePath(filePath);
  const { entries, targets } = await graphReactEvidence([filePath], referencingPaths, workspaceRoot);
  const identity = entries.find(entry => entry?.filePath === key)?.identity;
  for (const symbol of symbols) {
    delete symbol.framework;
    const local = identity?.components.some(component => component.name === symbol.name && component.startLine === symbol.line - 1);
    if (local || targets.get(key)?.has(symbol.name)) symbol.framework = 'react';
  }
}

/**
 * Importers of the graph's JS/TS files, read from the reverse index: file graphs rebuild on every file event,
 * so a fallback workspace scan or barrel resolution here delays event processing (#584).
 * shortcut: a consumer behind a barrel that is not in the graph is missed unless the component has local proof;
 * add one indexed hop through barrels if users report missing badges.
 */
export function collectReactReferencingPaths(
  nodes: readonly string[],
  lookup: (filePath: string) => readonly { path: string }[],
): string[] {
  const files = new Set(nodes.filter(filePath => JS_TS_FILE.test(filePath)).map(filePath => normalizePath(filePath)));
  return [...new Set([...files].flatMap(filePath => lookup(filePath).map(entry => normalizePath(entry.path))))];
}
