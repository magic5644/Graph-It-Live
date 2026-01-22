/**
 * Utility functions for node manipulation in the graph visualization
 * These are extracted from useGraphData for testability
 */

import dagre from '@dagrejs/dagre';
import { Edge, Node, Position } from 'reactflow';
import { GraphData } from '../../shared/types';

export const nodeWidth = 180;
export const nodeHeight = 40;

export const minNodeWidth = 120;
export const maxNodeWidth = 300;
export const charWidth = 7; // Approximate width per character at 12px font
// Sizes for small circular UI elements (action buttons, cycle indicator, symbol node)
export const actionButtonSize = 10; // Expand/Collapse, drill button, reference button
export const cycleIndicatorSize = 8; // Small red dot for cycle
export const symbolNodeSize = 40; // Circular symbol nodes

export interface NodeStyleResult {
    background: string;
    border: string;
    color: string;
    shape: 'rect' | 'circle';
}

/**
 * Extract filename from a full path
 */
export function getFileName(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
}

/**
 * Collect all nodes that have children (are sources of edges)
 */
export function collectNodesWithChildren(
    filePath: string | undefined,
    edges: { source: string; target: string }[]
): Set<string> {
    const allNodesWithChildren = new Set<string>();
    if (filePath) {
        allNodesWithChildren.add(filePath);
    }
    for (const edge of edges) {
        allNodesWithChildren.add(edge.source);
    }
    return allNodesWithChildren;
}

/**
 * Get node style based on file type and state
 */
export function getNodeStyle(
    fileName: string,
    path: string,
    isRoot: boolean,
    isSymbolNode: boolean = false
): NodeStyleResult {
    if (isRoot) {
        return {
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: '1px solid var(--vscode-button-background)',
            shape: 'rect',
        };
    }

    // Symbol nodes get circular shape and different styling
    if (isSymbolNode) {
        return {
            background: 'var(--vscode-editor-background)',
            border: '2px solid var(--vscode-button-background)',
            color: 'var(--vscode-editor-foreground)',
            shape: 'circle',
        };
    }

    const isNodeModule = /^(?!\.|\/|\\|[a-zA-Z]:)/.test(path);
    if (isNodeModule) {
        return {
            background: 'var(--vscode-sideBar-background)',
            border: '1px dashed var(--vscode-disabledForeground)',
            color: 'var(--vscode-editor-foreground)',
            shape: 'rect',
        };
    }

    const baseStyle: NodeStyleResult = {
        background: 'var(--vscode-editor-background)',
        color: 'var(--vscode-editor-foreground)',
        border: '1px solid var(--vscode-widget-border)',
        shape: 'rect',
    };

    // File type specific borders
    const borderColors: Record<string, string> = {
        '.ts': '#3178c6',     // TS Blue
        '.tsx': '#3178c6',    // TS Blue
        '.js': '#f7df1e',     // JS Yellow
        '.jsx': '#f7df1e',    // JS Yellow
        '.vue': '#41b883',    // Vue Green
        '.svelte': '#ff3e00', // Svelte Orange
        '.gql': '#e535ab',    // GraphQL Pink
        '.graphql': '#e535ab', // GraphQL Pink
    };

    for (const [ext, color] of Object.entries(borderColors)) {
        if (fileName.endsWith(ext)) {
            return { ...baseStyle, border: `1px solid ${color}` };
        }
    }

    return baseStyle;
}

/**
 * Check if a path represents an external package (node_modules)
 */
export function isNodeModulePath(path: string): boolean {
    return /^(?!\.|\/|\\|[a-zA-Z]:)/.test(path);
}

/**
 * Apply dagre layout to nodes and edges
 */
export function getLayoutedElements(
    nodes: Node[],
    edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    dagreGraph.setGraph({
        rankdir: 'LR',
        nodesep: 30,
        ranksep: 50,
        align: 'UL'
    });

    nodes.forEach((node) => {
        dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
    });

    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        return {
            ...node,
            targetPosition: Position.Left,
            sourcePosition: Position.Right,
            position: {
                x: nodeWithPosition.x - nodeWidth / 2,
                y: nodeWithPosition.y - nodeHeight / 2,
            },
        };
    });

    return { nodes: layoutedNodes, edges };
}

/**
 * Build CSS style object for a node
 */
export function buildNodeStyle(
    isRoot: boolean,
    shape: 'rect' | 'circle',
    background: string,
    color: string,
    border: string
): React.CSSProperties {
    return {
        background,
        color,
        border,
        borderRadius: shape === 'circle' ? '50%' : 4,
        padding: 10,
        fontSize: '12px',
        width: shape === 'circle' ? 80 : nodeWidth,
        height: shape === 'circle' ? 80 : nodeHeight,
        fontWeight: isRoot ? 'bold' : 'normal',
        cursor: 'pointer',
        textDecoration: isRoot ? 'underline' : 'none',
        textAlign: 'center',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        fontFamily: 'var(--vscode-font-family)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    };
}

/**
 * Create edge style for cycle detection visualization
 */
export function createEdgeStyle(isCircular: boolean): {
    style: React.CSSProperties;
    label?: string;
    labelStyle?: React.CSSProperties;
    labelBgStyle?: React.CSSProperties;
} {
    if (isCircular) {
        return {
            style: { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' },
            label: 'Cycle',
            labelStyle: { fill: '#ff4d4d', fontWeight: 'bold' },
            labelBgStyle: { fill: 'var(--vscode-editor-background)' },
        };
    }
    return {
        style: { stroke: 'var(--vscode-editor-foreground)' },
    };
}

/**
 * Calculate filename frequencies for disambiguation
 */
export function calculateFileNameCounts(paths: Iterable<string>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const path of paths) {
        const parts = path.split(/[/\\]/);
        const fileName = parts.findLast(p => p.length > 0) || '';
        if (fileName) {
            counts.set(fileName, (counts.get(fileName) || 0) + 1);
        }
    }
    return counts;
}

/**
 * Get disambiguated label for a node
 */
export function getNodeLabel(
    path: string,
    graphData: GraphData,
    fileNameCounts: Map<string, number>
): string {
    const fileName = path.split(/[/\\]/).pop() || path;

    // Use custom label if available
    if (graphData.nodeLabels?.[path]) {
        return graphData.nodeLabels[path];
    }

    // Disambiguate duplicate filenames
    if ((fileNameCounts.get(fileName) || 0) > 1) {
        const parentDir = path.split(/[/\\]/).slice(-2, -1)[0];
        if (parentDir) {
            return `${parentDir}/${fileName}`;
        }
    }

    return fileName;
}
