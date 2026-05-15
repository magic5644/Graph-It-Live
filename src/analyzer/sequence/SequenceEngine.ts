import * as fs from "node:fs";
import * as path from "node:path";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { IntraFileCallAnalyzer } from "@/analyzer/sequence/IntraFileCallAnalyzer";
import { orderMessages } from "@/analyzer/sequence/order";
import type {
  SequenceGenerationParams,
  SequenceMessage,
  SequenceModel,
  SequenceParticipant,
  SequenceWarning,
} from "@/analyzer/sequence/types";

type MinimalSymbol = {
  id: string;
  name: string;
  parentSymbolId?: string;
};

type MinimalDependency = {
  sourceSymbolId: string;
  targetSymbolId: string;
  targetFilePath: string;
};

type SymbolGraph = {
  symbols: MinimalSymbol[];
  dependencies: MinimalDependency[];
};

type SymbolRef = {
  filePath: string;
  symbolName: string;
};

function splitSymbolId(symbolId: string): SymbolRef {
  const index = symbolId.lastIndexOf(":");
  if (index < 0) {
    return {
      filePath: "",
      symbolName: symbolId,
    };
  }

  return {
    filePath: symbolId.slice(0, index),
    symbolName: symbolId.slice(index + 1),
  };
}

function isPathInsideRoot(candidatePath: string, workspaceRoot: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function toParticipantLabel(symbolId: string): string {
  const { symbolName } = splitSymbolId(symbolId);
  return symbolName || symbolId;
}

function toParticipantFilePath(symbolId: string, fallbackPath: string | null): string | null {
  const { filePath } = splitSymbolId(symbolId);
  if (filePath.length > 0) return filePath;
  return fallbackPath;
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

async function resolveRootSymbolId(
  params: SequenceGenerationParams,
  graph: SymbolGraph,
  warnings: SequenceWarning[],
): Promise<string> {
  const exactId = `${params.filePath}:${params.symbolName}`;
  if (graph.symbols.some((symbol) => symbol.id === exactId)) {
    return exactId;
  }

  const exactNameMatches = graph.symbols
    .filter((symbol) => splitSymbolId(symbol.id).symbolName === params.symbolName)
    .map((symbol) => symbol.id);

  if (exactNameMatches.length === 1) {
    return exactNameMatches[0] ?? exactId;
  }

  const methodNameMatches = graph.symbols
    .filter((symbol) => splitSymbolId(symbol.id).symbolName.endsWith(`.${params.symbolName}`))
    .map((symbol) => symbol.id);

  if (methodNameMatches.length === 1) {
    const methodMatch = methodNameMatches[0] ?? exactId;
    warnings.push({
      code: "AMBIGUOUS_TARGET",
      message: `Resolved method name '${params.symbolName}' to '${methodMatch}'.`,
      sourceFile: params.filePath,
    });
    return methodMatch;
  }

  const candidates = [...exactNameMatches, ...methodNameMatches];
  if (candidates.length > 0) {
    const selected = [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? exactId;
    warnings.push({
      code: "AMBIGUOUS_TARGET",
      message: `Multiple symbols match '${params.symbolName}'. Using '${selected}'.`,
      sourceFile: params.filePath,
    });
    return selected;
  }

  const symbolsWithOutgoingCalls = Array.from(
    new Set(
      graph.dependencies
        .map((dependency) => dependency.sourceSymbolId)
        .filter((symbolId) => symbolId.startsWith(`${params.filePath}:`)),
    ),
  );
  if (symbolsWithOutgoingCalls.length === 1) {
    const fallbackRoot = symbolsWithOutgoingCalls[0] ?? exactId;
    warnings.push({
      code: "AMBIGUOUS_TARGET",
      message: `Symbol '${params.symbolName}' unresolved. Falling back to call root '${fallbackRoot}'.`,
      sourceFile: params.filePath,
    });
    return fallbackRoot;
  }

  const hasNoSymbolData =
    graph.symbols.length === 0 && graph.dependencies.length === 0;
  if (hasNoSymbolData) {
    // Symbol analyzer unavailable for this language/file. Keep root deterministic,
    // avoid misleading unresolved warning.
    return exactId;
  }

  warnings.push({
    code: "UNRESOLVED_TARGET",
    message: `Could not resolve symbol '${params.symbolName}' in ${params.filePath}.`,
    sourceFile: params.filePath,
  });
  return exactId;
}

function createSpider(workspaceRoot: string, maxDepth: number): InstanceType<typeof SpiderBuilder>["build"] extends () => infer T ? T : never {
  const builder = new SpiderBuilder()
    .withRootDir(workspaceRoot)
    .withMaxDepth(Math.max(8, maxDepth + 2))
    .withExcludeNodeModules(true);

  const tsConfigPath = path.join(workspaceRoot, "tsconfig.json");
  if (fs.existsSync(tsConfigPath)) {
    builder.withTsConfigPath(tsConfigPath);
  }

  return builder.build();
}

function createParticipantRegistry(workspaceRoot: string): {
  ensureParticipant: (symbolId: string, fallbackFilePath: string | null) => string;
  getParticipants: () => SequenceParticipant[];
} {
  const participantBySymbolId = new Map<string, SequenceParticipant>();
  const participantAliasBySymbolId = new Map<string, string>();

  const ensureParticipant = (symbolId: string, fallbackFilePath: string | null): string => {
    const existingAlias = participantAliasBySymbolId.get(symbolId);
    if (existingAlias) return existingAlias;

    const filePath = toParticipantFilePath(symbolId, fallbackFilePath);
    const alias = `p${participantAliasBySymbolId.size + 1}`;
    participantAliasBySymbolId.set(symbolId, alias);
    participantBySymbolId.set(symbolId, {
      id: alias,
      label: toParticipantLabel(symbolId),
      filePath,
      external: filePath === null || !isPathInsideRoot(filePath, workspaceRoot),
    });
    return alias;
  };

  return {
    ensureParticipant,
    getParticipants: () => Array.from(participantBySymbolId.values()),
  };
}

function getOutgoingDependencies(
  symbolId: string,
  graph: SymbolGraph,
): { edges: MinimalDependency[]; usedParentFallback: boolean; parentSymbolId?: string } {
  const direct = graph.dependencies.filter((dependency) => dependency.sourceSymbolId === symbolId);
  if (direct.length > 0) {
    return { edges: direct, usedParentFallback: false };
  }

  const currentSymbol = graph.symbols.find((symbol) => symbol.id === symbolId);
  if (!currentSymbol?.parentSymbolId) {
    return { edges: [], usedParentFallback: false };
  }

  const parentEdges = graph.dependencies.filter(
    (dependency) => dependency.sourceSymbolId === currentSymbol.parentSymbolId,
  );
  return {
    edges: parentEdges,
    usedParentFallback: parentEdges.length > 0,
    parentSymbolId: currentSymbol.parentSymbolId,
  };
}

async function buildSequenceGraph(
  params: SequenceGenerationParams,
  rootId: string,
  loadSymbolGraph: (filePath: string) => Promise<SymbolGraph>,
  workspaceRoot: string,
  maxDepth: number,
  maxSteps: number,
  warnings: SequenceWarning[],
): Promise<{ messages: SequenceMessage[]; participants: SequenceParticipant[]; truncated: boolean }> {
  const messages: SequenceMessage[] = [];
  const queue: Array<{ symbolId: string; depth: number }> = [{ symbolId: rootId, depth: 0 }];
  const expanded = new Set<string>();
  const { ensureParticipant, getParticipants } = createParticipantRegistry(workspaceRoot);

  ensureParticipant(rootId, params.filePath);

  // Extract intra-file calls from root method
  const rootRef = splitSymbolId(rootId);
  if (rootRef.filePath && fs.existsSync(rootRef.filePath)) {
    try {
      const analyzer = new IntraFileCallAnalyzer();
      const intraFileCalls = await analyzer.extractCallsFromMethod(
        rootRef.filePath,
        rootRef.symbolName,
      );

      const symbolGraph = await loadSymbolGraph(rootRef.filePath);
      const fromAlias = ensureParticipant(rootId, rootRef.filePath);

      for (const call of intraFileCalls) {
        // Try to find matching symbol in graph
        const matchingSymbol = symbolGraph.symbols.find(
          (sym) =>
            sym.name === call.calleeName ||
            sym.name.endsWith(`.${call.calleeName}`),
        );

        if (matchingSymbol) {
          const toAlias = ensureParticipant(matchingSymbol.id, rootRef.filePath);
          messages.push({
            id: `${rootId}->${matchingSymbol.id}@${messages.length}`,
            fromParticipantId: fromAlias,
            toParticipantId: toAlias,
            label: call.calleeName,
            relationType: "CALLS",
            async: false,
            confidence: "high",
            sourceFile: rootRef.filePath,
            startLine: call.line,
            startCol: call.column,
            endLine: call.endLine,
            endCol: call.endColumn,
          });
        }
      }
    } catch {
      // Ignore intra-file extraction errors
    }
  }

  const markQueueItem = (current: { symbolId: string; depth: number }): boolean => {
    const expandedKey = `${current.depth}:${current.symbolId}`;
    if (expanded.has(expandedKey) || current.depth >= maxDepth) {
      return false;
    }
    expanded.add(expandedKey);
    return true;
  };

  const processDependency = (
    current: { symbolId: string; depth: number },
    currentRef: SymbolRef,
    dependency: MinimalDependency,
    confidence: "high" | "medium",
  ): void => {
    const targetFilePath = dependency.targetFilePath
      ? path.resolve(dependency.targetFilePath)
      : splitSymbolId(dependency.targetSymbolId).filePath;
    const targetInsideWorkspace =
      targetFilePath.length > 0 && isPathInsideRoot(targetFilePath, workspaceRoot);

    if (!params.includeExternal && !targetInsideWorkspace) {
      return;
    }

    const fromAlias = ensureParticipant(current.symbolId, currentRef.filePath);
    const toAlias = ensureParticipant(
      dependency.targetSymbolId,
      targetFilePath.length > 0 ? targetFilePath : null,
    );

    const targetRef = splitSymbolId(dependency.targetSymbolId);
    messages.push({
      id: `${current.symbolId}->${dependency.targetSymbolId}@${messages.length}`,
      fromParticipantId: fromAlias,
      toParticipantId: toAlias,
      label: targetRef.symbolName || dependency.targetSymbolId,
      relationType: "CALLS",
      async: false,
      confidence,
      sourceFile: currentRef.filePath,
      startLine: 0,
      startCol: 0,
      endLine: 0,
      endCol: 0,
    });

    if (targetInsideWorkspace) {
      queue.push({ symbolId: dependency.targetSymbolId, depth: current.depth + 1 });
      return;
    }

    warnings.push({
      code: "UNRESOLVED_TARGET",
      message: `External dependency: ${dependency.targetSymbolId}`,
      sourceFile: currentRef.filePath,
    });
  };

  const truncated = await traverseQueueForMessages({
    queue,
    maxSteps,
    maxDepth,
    markQueueItem,
    workspaceRoot,
    loadSymbolGraph,
    warnings,
    messages,
    processDependency,
  });

  if (truncated) {
    warnings.push({
      code: "TRUNCATED",
      message: `Truncated at maxSteps=${maxSteps}.`,
    });
  }

  // Add sequence numbers to all messages
  messages.forEach((msg, index) => {
    msg.sequenceNumber = index + 1;
  });

  return {
    messages,
    participants: getParticipants(),
    truncated,
  };
}

async function traverseQueueForMessages(input: {
  queue: Array<{ symbolId: string; depth: number }>;
  maxSteps: number;
  maxDepth: number;
  markQueueItem: (current: { symbolId: string; depth: number }) => boolean;
  workspaceRoot: string;
  loadSymbolGraph: (filePath: string) => Promise<SymbolGraph>;
  warnings: SequenceWarning[];
  messages: SequenceMessage[];
  processDependency: (
    current: { symbolId: string; depth: number },
    currentRef: SymbolRef,
    dependency: MinimalDependency,
    confidence: "high" | "medium",
  ) => void;
}): Promise<boolean> {
  let truncated = false;

  while (input.queue.length > 0 && input.messages.length < input.maxSteps) {
    const current = input.queue.shift();
    if (!current) {
      continue;
    }

    if (current.depth >= input.maxDepth || !input.markQueueItem(current)) {
      continue;
    }

    const wasTruncated = await expandCurrentQueueItem(input, current);
    if (wasTruncated) truncated = true;
  }

  return truncated || (input.messages.length >= input.maxSteps && input.queue.length > 0);
}

async function expandCurrentQueueItem(
  input: {
    maxSteps: number;
    workspaceRoot: string;
    loadSymbolGraph: (filePath: string) => Promise<SymbolGraph>;
    warnings: SequenceWarning[];
    messages: SequenceMessage[];
    processDependency: (
      current: { symbolId: string; depth: number },
      currentRef: SymbolRef,
      dependency: MinimalDependency,
      confidence: "high" | "medium",
    ) => void;
  },
  current: { symbolId: string; depth: number },
): Promise<boolean> {
  const currentRef = splitSymbolId(current.symbolId);
  if (!currentRef.filePath || !isPathInsideRoot(currentRef.filePath, input.workspaceRoot)) {
    return false;
  }

  const currentGraph = await input.loadSymbolGraph(currentRef.filePath);
  const outgoingInfo = getOutgoingDependencies(current.symbolId, currentGraph);
  if (outgoingInfo.usedParentFallback && outgoingInfo.parentSymbolId) {
    input.warnings.push({
      code: "AMBIGUOUS_TARGET",
      message: `No direct method dependencies for '${current.symbolId}'. Used class-level dependencies from '${outgoingInfo.parentSymbolId}'.`,
      sourceFile: currentRef.filePath,
    });
  }

  for (const dependency of outgoingInfo.edges) {
    if (input.messages.length >= input.maxSteps) {
      return true;
    }
    input.processDependency(
      current,
      currentRef,
      dependency,
      outgoingInfo.usedParentFallback ? "medium" : "high",
    );
  }

  return false;
}

export async function generateSequence(
  params: SequenceGenerationParams,
): Promise<SequenceModel> {
  const startedAt = Date.now();
  const warnings: SequenceWarning[] = [];

  if (!isPathInsideRoot(params.filePath, params.workspaceRoot)) {
    throw new Error(`Path outside workspace root: ${params.filePath}`);
  }

  const maxDepth = clampPositive(params.maxDepth, 6);
  const maxSteps = clampPositive(params.maxSteps, 200);
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const graphCache = new Map<string, SymbolGraph>();
  const spider = params.resolveSymbolGraph ? null : createSpider(workspaceRoot, maxDepth);

  const loadSymbolGraph = async (filePath: string): Promise<SymbolGraph> => {
    const resolvedPath = path.resolve(filePath);
    const cached = graphCache.get(resolvedPath);
    if (cached) return cached;

    let graph: SymbolGraph;
    if (params.resolveSymbolGraph) {
      graph = await params.resolveSymbolGraph(resolvedPath);
    } else if (spider) {
      graph = await spider.getSymbolGraph(resolvedPath);
    } else {
      graph = { symbols: [], dependencies: [] };
    }

    graphCache.set(resolvedPath, graph);
    return graph;
  };

  try {
    const rootGraph = await loadSymbolGraph(params.filePath);
    const rootId = await resolveRootSymbolId(params, rootGraph, warnings);

    const buildResult = await buildSequenceGraph(
      params,
      rootId,
      loadSymbolGraph,
      workspaceRoot,
      maxDepth,
      maxSteps,
      warnings,
    );
    const orderedMessages = orderMessages(buildResult.messages);

    return {
      root: {
        id: rootId,
        symbolName: params.symbolName,
        filePath: params.filePath,
      },
      participants: buildResult.participants,
      messages: orderedMessages,
      warnings,
      truncated: buildResult.truncated,
      stats: {
        participantsCount: buildResult.participants.length,
        messagesCount: orderedMessages.length,
        analysisTimeMs: Date.now() - startedAt,
      },
    };
  } finally {
    if (spider) {
      await spider.dispose();
    }
  }
}