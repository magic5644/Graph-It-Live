import { GraphData } from '../../shared/types';

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
