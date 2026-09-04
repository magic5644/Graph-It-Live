import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizePath } from '@/shared/path';
import type { GraphContextEdge, GraphContextNode } from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';
import { toEvidence } from './GraphContextEvidence';

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.yaml', '.yml']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cs', '.c', '.cpp', '.h', '.hpp']);
const RATIONALE_MARKER = /(?:^|\/\/|#|\/\*)\s*(WHY|NOTE|HACK)\s*:\s*(.+?)(?:\*\/\s*)?$/i;
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const RST_LINK = /`[^`]+\s+<([^>]+)>`_/g;

export interface DocumentReferenceIndex {
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
}

/** Local, deterministic index of documentation references and rationale markers. */
export class DocumentReferenceIndexer {
  constructor(private readonly workspaceRoot: string) {}

  async index(scope = '**'): Promise<DocumentReferenceIndex> {
    const root = normalizePath(this.workspaceRoot);
    const matcher = compileFileScope(root, scope);
    const files = await collectFiles(root);
    const nodes = new Map<string, GraphContextNode>();
    const edges: GraphContextEdge[] = [];

    for (const filePath of files) {
      const relativePath = relativePathOf(filePath, root);
      if (!relativePath || !matcher.matches(filePath)) continue;
      const content = await readText(filePath);
      if (content === null) continue;
      const isDocument = DOCUMENT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
      const documentId = isDocument ? `document:${relativePath}` : undefined;
      if (documentId) nodes.set(documentId, {
        id: documentId, kind: 'document', name: path.posix.basename(relativePath), path: relativePath,
        language: path.posix.extname(relativePath).slice(1),
      });

      const lines = content.split(/\r?\n/);
      const rationaleIds: string[] = [];
      const heading = lines.find(line => /^#{1,6}\s+/.test(line))?.replace(/^#{1,6}\s+/, '').trim();
      if (documentId && heading) {
        const document = nodes.get(documentId);
        if (document) nodes.set(documentId, { ...document, name: heading });
      }
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const marker = line.match(RATIONALE_MARKER);
        if (marker) {
          const rationaleId = `rationale:${relativePath}:${lineNumber}`;
          nodes.set(rationaleId, {
            id: rationaleId,
            kind: 'rationale',
            name: marker[2].trim(),
            path: relativePath,
            startLine: lineNumber,
            endLine: lineNumber,
          });
          rationaleIds.push(rationaleId);
          if (documentId) edges.push(toEvidence({
            source: rationaleId,
            target: documentId,
            relation: 'EXPLAINS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: lineNumber,
          }));
          if (!documentId) edges.push(toEvidence({
            source: rationaleId,
            target: `file:${relativePath}`,
            relation: 'EXPLAINS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: lineNumber,
          }));
        }
      });

      for (const link of linksIn(content)) {
        const target = resolveLocalTarget(filePath, link.target, root);
        if (!target) continue;
        const targetId = DOCUMENT_EXTENSIONS.has(path.extname(target).toLowerCase())
          ? `document:${target}`
          : `file:${target}`;
        if (!documentId && !isCodePath(target)) continue;
        const sourceId = documentId ?? `file:${relativePath}`;
        edges.push(toEvidence({
          source: sourceId,
          target: targetId,
          relation: 'REFERENCES',
          origin: 'AST',
          workspaceRoot: root,
          sourcePath: filePath,
          sourceLine: lineNumberAt(content, link.offset),
        }));
        if (documentId && isCodePath(target)) {
          edges.push(toEvidence({
            source: documentId,
            target: targetId,
            relation: 'DOCUMENTS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: lineNumberAt(content, link.offset),
          }));
        }
        for (const rationaleId of rationaleIds) {
          if (isCodePath(target)) edges.push(toEvidence({
            source: rationaleId,
            target: `file:${target}`,
            relation: 'EXPLAINS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: lineNumberAt(content, link.offset),
          }));
        }
      }
    }

    return { nodes: [...nodes.values()].sort(byId), edges: dedupeEdges(edges) };
  }

  buildIndex(scope = '**'): Promise<DocumentReferenceIndex> {
    return this.index(scope);
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out' || entry.name === 'dist') continue;
      const filePath = normalizePath(path.join(directory, entry.name));
      if (entry.isDirectory()) await visit(filePath);
      else if (DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(filePath);
    }
  };
  await visit(root);
  return result.sort();
}

async function readText(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 1_000_000) return null;
    return await readFile(filePath, 'utf8');
  } catch { return null; }
}

function linksIn(content: string): Array<{ target: string; offset: number }> {
  return [...content.matchAll(MARKDOWN_LINK), ...content.matchAll(RST_LINK)]
    .map(match => ({ target: match[1], offset: match.index ?? 0 }));
}

function resolveLocalTarget(sourcePath: string, rawTarget: string, root: string): string | null {
  const target = rawTarget.split('#', 1)[0].trim();
  if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) return null;
  const resolved = normalizePath(path.resolve(path.dirname(sourcePath), target));
  const relative = relativePathOf(resolved, root);
  return relative && relative !== '.' ? relative : null;
}

function relativePathOf(filePath: string, root: string): string | null {
  const relative = normalizePath(path.relative(root, filePath));
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
}

function isCodePath(filePath: string): boolean {
  return !DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function dedupeEdges(edges: GraphContextEdge[]): GraphContextEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = [edge.source, edge.target, edge.relation, edge.sourceLine].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => `${left.source}\u0000${left.target}\u0000${left.relation}`.localeCompare(`${right.source}\u0000${right.target}\u0000${right.relation}`));
}

function byId(left: GraphContextNode, right: GraphContextNode): number { return left.id.localeCompare(right.id); }
