import { GraphData } from '../../shared/types';

/**
 * Extract filename from a full path
 */
export const getFileName = (path: string): string => {
    const parts = path.split(/[/\\]/).filter(p => p.length > 0);
    return parts.pop() || '';
};

/**
 * Get parent directory name from a path
 */
export const getParentDir = (path: string): string | undefined => {
    const parts = path.split(/[/\\]/);
    return parts.length >= 2 ? parts[parts.length - 2] : undefined;
};

/**
 * Get disambiguated label for a node (add parent dir if filename is duplicated)
 */
export const getDisambiguatedLabel = (
    path: string,
    nodeLabels?: Record<string, string>,
    fileNameCounts?: Map<string, number>
): string => {
    const fileName = getFileName(path);
    
    // Use custom label if available
    if (nodeLabels?.[path]) {
        return nodeLabels[path];
    }
    
    // Disambiguate duplicate filenames
    if (fileNameCounts && (fileNameCounts.get(fileName) || 0) > 1) {
        const parentDir = getParentDir(path);
        if (parentDir) {
            return `${parentDir}/${fileName}`;
        }
    }
    
    return fileName;
};

/**
 * Count occurrences of each filename in a list of paths
 */
export const countFileNames = (paths: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const path of paths) {
        const fileName = getFileName(path);
        counts.set(fileName, (counts.get(fileName) || 0) + 1);
    }
    return counts;
};

/**
 * Check if a path represents a node_modules package or external dependency
 */
export const isExternalPackage = (path: string): boolean => {
    if (!path) return false;
    
    // Known file extensions = not external
    const fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.gql', '.graphql'];
    for (const ext of fileExtensions) {
        if (path.endsWith(ext)) return false;
    }
    
    // Starts with . or / or drive letter = local file
    if (path.startsWith('.') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
        return false;
    }
    
    // Contains path separators but no extension = likely local file
    if ((path.includes('/') || path.includes('\\')) && !path.includes('node_modules')) {
        return false;
    }
    
    return true;
};

/**
 * Calculate visible nodes and edges based on expansion state
 */
export const calculateVisibleGraph = (
    graphData: GraphData,
    rootPath: string,
    expandedNodes: Set<string>
): { visibleNodes: Set<string>; visibleEdges: { source: string; target: string }[] } => {
    const visibleNodes = new Set<string>();
    const visibleEdges: { source: string; target: string }[] = [];
    const visited = new Set<string>();
    const addedEdgeIds = new Set<string>();

    visibleNodes.add(rootPath);

    const addEdge = (edge: { source: string; target: string }) => {
        const edgeId = `${edge.source}-${edge.target}`;
        if (!addedEdgeIds.has(edgeId)) {
            addedEdgeIds.add(edgeId);
            visibleEdges.push(edge);
        }
    };

    const addChildren = (parentId: string) => {
        if (visited.has(parentId)) return;
        visited.add(parentId);

        const childrenEdges = graphData.edges.filter(e => e.source === parentId);
        childrenEdges.forEach(edge => {
            visibleNodes.add(edge.target);
            addEdge(edge);
            if (expandedNodes.has(edge.target)) {
                addChildren(edge.target);
            }
        });
    };

    addChildren(rootPath);

    // Add incoming edges to root (Referenced By)
    const incomingEdges = graphData.edges.filter(e => e.target === rootPath);
    incomingEdges.forEach(edge => {
        visibleNodes.add(edge.source);
        addEdge(edge);
    });

    return { visibleNodes, visibleEdges };
};

export const mergeGraphData = (currentData: GraphData, newData: GraphData): GraphData => {
    const mergedNodes = [...new Set([...currentData.nodes, ...newData.nodes])];
    const mergedEdges = [
        ...currentData.edges,
        ...newData.edges.filter(newEdge =>
            !currentData.edges.some(e =>
                e.source === newEdge.source && e.target === newEdge.target
            )
        )
    ];

    // Merge nodeLabels
    const mergedNodeLabels = {
        ...currentData.nodeLabels,
        ...newData.nodeLabels,
    };

    return {
        nodes: mergedNodes,
        edges: mergedEdges,
        nodeLabels: Object.keys(mergedNodeLabels).length > 0 ? mergedNodeLabels : undefined,
    };
};

export const detectCycles = (graphData: GraphData) => {
    const cycleEdges = new Set<string>();
    const cycleNodes = new Set<string>();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const detectCycleRecursive = (node: string, path: string[]) => {
        visited.add(node);
        recursionStack.add(node);

        const edges = graphData.edges.filter(e => e.source === node);
        for (const edge of edges) {
            if (recursionStack.has(edge.target)) {
                // Cycle detected!
                cycleEdges.add(`${edge.source}-${edge.target}`);

                // Add all nodes in the cycle path to cycleNodes
                cycleNodes.add(edge.source);
                cycleNodes.add(edge.target);

                // Add all nodes in the current recursion stack (they're part of the cycle)
                recursionStack.forEach(n => cycleNodes.add(n));
            } else if (!visited.has(edge.target)) {
                detectCycleRecursive(edge.target, [...path, edge.target]);
            }
        }

        recursionStack.delete(node);
    };

    // Run detection starting from all nodes to cover disconnected components
    const allNodes = new Set<string>();
    graphData.edges.forEach(e => {
        allNodes.add(e.source);
        allNodes.add(e.target);
    });

    allNodes.forEach(node => {
        if (!visited.has(node)) {
            detectCycleRecursive(node, [node]);
        }
    });

    return { cycleEdges, cycleNodes };
};
