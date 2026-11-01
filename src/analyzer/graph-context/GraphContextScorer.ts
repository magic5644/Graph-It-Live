import type { QueryEngine } from '@/analyzer/QueryEngine';
import { splitIdentifier } from '@/analyzer/callgraph/CallGraphQuery';
import {
  extractQueryKeywords,
  foldAccents,
  isQueryStopword,
  questionTerms,
} from '@/analyzer/query/keywords';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextMode,
  GraphContextNode,
  GraphContextRelation,
} from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;
// Outweighs every per-keyword score so a name equal to a whole question word ranks
// before names that only share its split tokens (`normalizePath` vs `normalizeRelativePath`).
const EXACT_IDENTIFIER_SCORE = 1000;

export interface ScoredGraphContextNode {
  node: GraphContextNode;
  score: number;
}

export interface GraphContextScorerOptions {
  queryEngine?: Pick<QueryEngine, 'scoreSeedNodes'>;
  workspaceRoot: string;
}

/** Deterministic local ranking for graph-context seeds and traversal edges. */
export class GraphContextScorer {
  private readonly queryEngine: Pick<QueryEngine, 'scoreSeedNodes'> | undefined;
  private readonly workspaceRoot: string;
  // scoreRelation runs once per traversed edge with the same question: tokenize once.
  private lastQuestion: string | undefined;
  private lastQuestionTokens = new Set<string>();

  constructor(options: GraphContextScorerOptions) {
    this.queryEngine = options.queryEngine;
    this.workspaceRoot = normalizePath(options.workspaceRoot);
  }

  extractKeywords(question: string): string[] {
    return extractQueryKeywords(question);
  }

  scoreSearchNodes(
    question: string,
    nodes: GraphContextNode[],
    scope?: string,
  ): ScoredGraphContextNode[] {
    const keywords = this.extractKeywords(question);
    if (keywords.length === 0) return [];

    const ftsScores = this.getFtsScores(keywords, scope);
    const questionTokens = this.questionTokens(question);
    const questionIdentifiers = new Set(
      question.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter(word => word && !isQueryStopword(word)),
    );

    return nodes
      .map((node): ScoredGraphContextNode => ({
        node,
        score: this.scoreNode(node, keywords, questionTokens, questionIdentifiers, ftsScores),
      }))
      .filter(candidate => candidate.score > 0)
      .sort(compareScoredNodes);
  }

  scoreRelation(
    mode: GraphContextMode,
    relation: GraphContextRelation,
    question: string,
    node: GraphContextNode,
  ): number {
    const questionTokens = this.questionTokens(question);
    let score = relationPriority(mode, relation);

    if (hasIntentStem(questionTokens, ['call', 'flow'])) {
      if (relation === 'CALLS') score += 30;
    }
    if (hasIntentStem(questionTokens, ['depend', 'impact'])) {
      if (relation === 'IMPORTS' || relation === 'USES') score += 25;
    }
    if (hasIntentStem(questionTokens, ['implement', 'refactor'])) {
      if (relation === 'IMPLEMENTS' || relation === 'INHERITS') score += 35;
    }
    if (node.kind === 'test') score += mode === 'refactor' ? -60 : 10;

    return score;
  }

  /** Raw question tokens plus glossary terms, so intents work in every language (`appel` → call). */
  private questionTokens(question: string): Set<string> {
    if (question !== this.lastQuestion) {
      this.lastQuestion = question;
      this.lastQuestionTokens = new Set([...splitIdentifier(question), ...questionTerms(question)]);
    }
    return this.lastQuestionTokens;
  }

  private getFtsScores(keywords: string[], scope: string | undefined): Map<string, number> {
    if (!this.queryEngine) return new Map();

    const fileScope = compileFileScope(this.workspaceRoot, scope ?? '**');
    const rankedNodes = this.queryEngine.scoreSeedNodes(keywords, fileScope);
    const scores = new Map<string, number>();

    for (const node of rankedNodes) {
      const normalizedPath = normalizePath(node.path);
      const key = nodeLookupKey(normalizedPath, node.name, node.startLine);
      scores.set(key, Math.max(scores.get(key) ?? 0, node.relevanceScore));
      const pathAndNameKey = nodeLookupKey(normalizedPath, node.name);
      scores.set(pathAndNameKey, Math.max(scores.get(pathAndNameKey) ?? 0, node.relevanceScore));
    }

    return scores;
  }

  private scoreNode(
    node: GraphContextNode,
    keywords: string[],
    questionTokens: Set<string>,
    questionIdentifiers: Set<string>,
    ftsScores: Map<string, number>,
  ): number {
    const absolutePath = qualifyPath(this.workspaceRoot, node.path);
    const ftsScore = absolutePath === undefined
      ? 0
      : ftsScores.get(nodeLookupKey(absolutePath, node.name, node.startLine))
        ?? ftsScores.get(nodeLookupKey(absolutePath, node.name))
        ?? 0;
    let score = ftsScore * 20 + keywordScore(node, keywords);
    if (questionIdentifiers.has(node.name.toLowerCase())) score += EXACT_IDENTIFIER_SCORE;
    // Kind and intent bonuses rank nodes the question matches; alone they would seed every file.
    if (score === 0) return 0;

    if (questionTokens.has(node.kind)) score += 8;
    if (questionTokens.has('file') && node.kind === 'file') score += 8;
    if (questionTokens.has('caller') && node.kind === 'symbol') score += 4;
    if (node.kind === 'symbol') score += 1;
    // A test named after the feature (`dispatchedCommands`) otherwise outranks the
    // code the question is about; keep tests first only when the question asks for them.
    if (node.kind === 'test' && !hasIntentStem(questionTokens, ['test', 'spec'])) score /= 4;

    return score;
  }
}

function keywordScore(node: GraphContextNode, keywords: string[]): number {
  const normalizedName = foldAccents(node.name);
  const normalizedPath = foldAccents(node.path ?? '');
  // Split before folding: folding lowercases and would hide camelCase boundaries.
  const nameTokens = new Set(splitIdentifier(node.name).map(foldAccents));
  const pathTokens = new Set(splitIdentifier(node.path ?? '').map(foldAccents));
  let score = 0;

  for (const keyword of keywords) {
    if (normalizedName === keyword) score += 16;
    else if (normalizedName.startsWith(keyword)) score += 10;
    if (nameTokens.has(keyword)) score += 8;
    if (pathTokens.has(keyword)) score += 4;
    else if (normalizedPath.includes(keyword)) score += 2;
  }

  return score;
}

function hasIntentStem(tokens: Set<string>, stems: string[]): boolean {
  return [...tokens].some(token => stems.some(stem => token.startsWith(stem)));
}

function qualifyPath(workspaceRoot: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const normalizedPath = normalizePath(filePath);
  if (normalizedPath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalizedPath)) {
    return normalizedPath;
  }
  const normalizedRoot = workspaceRoot.replace(/\/$/, '');
  return normalizePath(`${normalizedRoot}/${normalizedPath.replace(/^\//, '')}`);
}

function nodeLookupKey(filePath: string, name: string, startLine?: number): string {
  return `${normalizePath(filePath)}\u0000${name}\u0000${startLine ?? ''}`;
}

function relationPriority(mode: GraphContextMode, relation: GraphContextRelation): number {
  if (mode === 'refactor') {
    const priorities: Partial<Record<GraphContextRelation, number>> = {
      IMPLEMENTS: 120,
      INHERITS: 115,
      CALLS: 100,
      USES: 95,
      IMPORTS: 90,
      TESTED_BY: 80,
      CONTAINS: 40,
    };
    return priorities[relation] ?? 60;
  }

  const priorities: Partial<Record<GraphContextRelation, number>> = {
    CALLS: 100,
    IMPLEMENTS: 95,
    INHERITS: 90,
    USES: 85,
    IMPORTS: 80,
    TESTED_BY: 75,
    CONTAINS: 60,
  };
  return priorities[relation] ?? 50;
}

function compareScoredNodes(
  left: ScoredGraphContextNode,
  right: ScoredGraphContextNode,
): number {
  return right.score - left.score || left.node.id.localeCompare(right.node.id);
}
