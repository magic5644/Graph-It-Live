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
const JSX_LINK = /<[A-Za-z][^>]*\s(?:href|to)\s*=\s*(["'])([^"']+)\1[^>]*>/g;

interface DocumentHeading {
  line: number;
  title: string;
}

interface DocumentLink {
  target: string;
  line: number;
}

interface RationaleMarker {
  id: string;
  line: number;
}

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
      const extension = path.extname(relativePath).toLowerCase();
      const documentId = isDocument ? `document:${relativePath}` : undefined;
      if (documentId) nodes.set(documentId, {
        id: documentId, kind: 'document', name: path.posix.basename(relativePath), path: relativePath,
        language: path.posix.extname(relativePath).slice(1),
      });

      const lines = content.split(/\r?\n/);
      const rationaleMarkers: RationaleMarker[] = [];
      const markerLines = new Set<number>();
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const marker = rationaleIn(line, extension);
        if (marker) {
          const rationaleId = `rationale:${relativePath}:${lineNumber}`;
          nodes.set(rationaleId, {
            id: rationaleId,
            kind: 'rationale',
            name: marker.text,
            path: relativePath,
            startLine: lineNumber,
            endLine: lineNumber,
          });
          rationaleMarkers.push({ id: rationaleId, line: lineNumber });
          markerLines.add(lineNumber);
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

      const documentHeadings = headingsIn(lines, extension, markerLines);
      if (documentId && documentHeadings[0]) {
        const document = nodes.get(documentId);
        if (document) nodes.set(documentId, { ...document, name: documentHeadings[0].title });
      }
      const codeLinks: Array<DocumentLink & { targetPath: string }> = [];

      for (const link of linksIn(lines, extension)) {
        const target = resolveLocalTarget(filePath, link.target, root);
        if (!target) continue;
        const targetIsDocument = DOCUMENT_EXTENSIONS.has(path.extname(target).toLowerCase());
        const targetIsCode = isCodePath(target);
        if (!targetIsDocument && !targetIsCode) continue;
        const targetId = targetIsDocument
          ? `document:${target}`
          : `file:${target}`;
        if (!documentId && !targetIsCode) continue;
        const sourceId = documentId ?? `file:${relativePath}`;
        edges.push(toEvidence({
          source: sourceId,
          target: targetId,
          relation: 'REFERENCES',
          origin: 'AST',
          workspaceRoot: root,
          sourcePath: filePath,
          sourceLine: link.line,
        }));
        if (documentId && targetIsCode) {
          codeLinks.push({ ...link, targetPath: target });
          edges.push(toEvidence({
            source: documentId,
            target: targetId,
            relation: 'DOCUMENTS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: link.line,
          }));
        }
      }

      for (const marker of rationaleMarkers) {
        for (const link of nearestSectionLinks(marker.line, codeLinks, documentHeadings)) {
          edges.push(toEvidence({
            source: marker.id,
            target: `file:${link.targetPath}`,
            relation: 'EXPLAINS',
            origin: 'AST',
            workspaceRoot: root,
            sourcePath: filePath,
            sourceLine: link.line,
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

function linksIn(lines: string[], extension: string): DocumentLink[] {
  if (extension === '.yaml' || extension === '.yml') return yamlLinksIn(lines);

  const links: DocumentLink[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      fence = fence === fenceMatch[1] ? undefined : fence ?? fenceMatch[1];
      return;
    }
    if (fence) return;

    const patterns = extension === '.rst'
      ? [{ regex: RST_LINK, targetIndex: 1 }]
      : [
          { regex: MARKDOWN_LINK, targetIndex: 1 },
          ...(extension === '.mdx' ? [{ regex: JSX_LINK, targetIndex: 2 }] : []),
        ];
    for (const { regex, targetIndex } of patterns) {
      for (const match of line.matchAll(regex)) {
        const target = match[targetIndex];
        if (target) links.push({ target, line: index + 1 });
      }
    }
  });
  return links;
}

function yamlLinksIn(lines: string[]): DocumentLink[] {
  return lines.flatMap((line, index): DocumentLink[] => {
    const { content } = splitYamlLine(line);
    const separator = content.indexOf(':');
    const rawValue = separator >= 0
      ? content.slice(separator + 1).trim()
      : content.trim().replace(/^-\s*/, '');
    const target = unquoteYamlScalar(rawValue);
    return target && isSupportedTarget(target) ? [{ target, line: index + 1 }] : [];
  });
}

function headingsIn(
  lines: string[],
  extension: string,
  markerLines: ReadonlySet<number>,
): DocumentHeading[] {
  if (extension === '.rst') {
    return lines.flatMap((line, index): DocumentHeading[] => (
      index > 0
      && /^\s*([=\-~^"'#:<>_+*])\1{2,}\s*$/.test(line)
      && lines[index - 1].trim()
        ? [{ line: index, title: lines[index - 1].trim() }]
        : []
    ));
  }
  if (extension !== '.md' && extension !== '.mdx') return [];
  return lines.flatMap((line, index): DocumentHeading[] => {
    if (markerLines.has(index + 1)) return [];
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    return match ? [{ line: index + 1, title: match[1].trim() }] : [];
  });
}

function rationaleIn(line: string, extension: string): { text: string } | null {
  if (extension === '.yaml' || extension === '.yml') {
    const { comment } = splitYamlLine(line);
    const marker = comment?.match(/^\s*(WHY|NOTE|HACK)\s*:\s*(.+?)\s*$/i);
    return marker ? { text: marker[2].trim() } : null;
  }
  const marker = line.match(RATIONALE_MARKER);
  return marker ? { text: marker[2].trim() } : null;
}

function splitYamlLine(line: string): { content: string; comment?: string } {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === character ? undefined : quote ?? character;
    } else if (character === '#' && quote === undefined) {
      return { content: line.slice(0, index), comment: line.slice(index + 1) };
    }
    escaped = false;
  }
  return { content: line };
}

function unquoteYamlScalar(value: string): string | null {
  if (!value) return null;
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  return value.endsWith(quote) ? value.slice(1, -1) : null;
}

function isSupportedTarget(target: string): boolean {
  const withoutFragment = target.split('#', 1)[0].trim();
  const extension = path.extname(withoutFragment).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(extension) || CODE_EXTENSIONS.has(extension);
}

function nearestSectionLinks<T extends DocumentLink>(
  markerLine: number,
  links: T[],
  headings: DocumentHeading[],
): T[] {
  const section = sectionAt(markerLine, headings);
  const candidates = links.filter(link => sectionAt(link.line, headings) === section);
  const nearestDistance = Math.min(...candidates.map(link => Math.abs(link.line - markerLine)));
  return candidates.filter(link => Math.abs(link.line - markerLine) === nearestDistance);
}

function sectionAt(line: number, headings: DocumentHeading[]): number {
  let section = 0;
  for (const heading of headings) {
    if (heading.line > line) break;
    section = heading.line;
  }
  return section;
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
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
