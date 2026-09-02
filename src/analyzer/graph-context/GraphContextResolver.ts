import path from 'node:path';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextCandidate,
  GraphContextNode,
  GraphContextResolution,
  GraphContextSeed,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';

const SCORE_EXACT_ID = 1;
const SCORE_EXACT_PATH = 0.95;
const SCORE_EXACT_NAME_AND_PATH = 0.9;
const SCORE_EXACT_NAME = 0.85;
const SCORE_EXACT_LABEL = 0.75;
const SCORE_LABEL_PREFIX = 0.65;
const SCORE_LABEL_CONTAINS = 0.55;

export function resolveSeeds(
  seed: GraphContextSeed,
  snapshot: GraphContextSnapshot,
  scope?: string,
): GraphContextResolution {
  const scopedNodes = filterByScope(snapshot.nodes, scope);

  if (seed.id) {
    const idMatches = scopedNodes.filter(node => node.id === seed.id);
    if (idMatches.length > 0) return resolveExact(idMatches, SCORE_EXACT_ID, 'Exact stable ID');
  }

  const normalizedFilePath = seed.filePath
    ? normalizeRelativePath(seed.filePath)
    : undefined;

  if (normalizedFilePath && !seed.symbolName) {
    const pathMatches = scopedNodes.filter(node => (
      node.kind === 'file'
      && node.path !== undefined
      && normalizeRelativePath(node.path) === normalizedFilePath
    ));
    if (pathMatches.length > 0) {
      return resolveExact(pathMatches, SCORE_EXACT_PATH, 'Exact relative path');
    }
  }

  if (normalizedFilePath && seed.symbolName) {
    const nameAndPathMatches = scopedNodes.filter(node => (
      isSymbolNode(node)
      && node.name === seed.symbolName
      && node.path !== undefined
      && normalizeRelativePath(node.path) === normalizedFilePath
    ));
    if (nameAndPathMatches.length > 0) {
      return resolveExact(
        nameAndPathMatches,
        SCORE_EXACT_NAME_AND_PATH,
        'Exact symbol name and path',
      );
    }
  }

  if (seed.symbolName) {
    const nameMatches = scopedNodes.filter(node => (
      isSymbolNode(node) && node.name === seed.symbolName
    ));
    if (nameMatches.length > 0) {
      return resolveExact(nameMatches, SCORE_EXACT_NAME, 'Exact symbol name');
    }
  }

  if (seed.label?.trim()) {
    const labelCandidates = scoreLabelMatches(seed.label, scopedNodes);
    if (labelCandidates.length > 0) return resolveCandidates(labelCandidates);
  }

  return notFoundResolution();
}

function filterByScope(nodes: GraphContextNode[], scope: string | undefined): GraphContextNode[] {
  if (scope === undefined) return nodes;

  const matcher = compileFileScope('/', scope);
  return nodes.filter(node => (
    node.path !== undefined
    && matcher.matches(`/${normalizeRelativePath(node.path)}`)
  ));
}

function normalizeRelativePath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const resolved = normalizePath(path.posix.normalize(normalized));
  return resolved.replace(/^\.\//, '');
}

function isSymbolNode(node: GraphContextNode): boolean {
  return node.kind === 'symbol' || node.kind === 'test';
}

function resolveExact(
  nodes: GraphContextNode[],
  score: number,
  reason: string,
): GraphContextResolution {
  return resolveCandidates(nodes.map(node => ({ node, score, reason })));
}

function scoreLabelMatches(label: string, nodes: GraphContextNode[]): GraphContextCandidate[] {
  const normalizedLabel = label.trim().toLowerCase();
  return nodes.flatMap((node) => {
    const normalizedName = node.name.toLowerCase();
    let score: number | undefined;
    let reason: string | undefined;

    if (normalizedName === normalizedLabel) {
      score = SCORE_EXACT_LABEL;
      reason = 'Case-insensitive exact label';
    } else if (normalizedName.startsWith(normalizedLabel)) {
      score = SCORE_LABEL_PREFIX;
      reason = 'Case-insensitive label prefix';
    } else if (normalizedName.includes(normalizedLabel)) {
      score = SCORE_LABEL_CONTAINS;
      reason = 'Case-insensitive label substring';
    }

    return score === undefined || reason === undefined
      ? []
      : [{ node, score, reason }];
  });
}

function resolveCandidates(candidates: GraphContextCandidate[]): GraphContextResolution {
  const sortedCandidates = [...candidates].sort(compareCandidates);
  const topScore = sortedCandidates[0]?.score;
  const topCandidates = sortedCandidates.filter(candidate => candidate.score === topScore);
  const ambiguous = topCandidates.length > 1;

  return {
    selected: ambiguous ? undefined : topCandidates[0]?.node,
    candidates: sortedCandidates,
    ambiguous,
    notFound: false,
  };
}

function compareCandidates(left: GraphContextCandidate, right: GraphContextCandidate): number {
  return right.score - left.score || left.node.id.localeCompare(right.node.id);
}

function notFoundResolution(): GraphContextResolution {
  return {
    candidates: [],
    ambiguous: false,
    notFound: true,
  };
}
