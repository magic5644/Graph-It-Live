import React, { useState } from "react";
import type { SymbolDependency, SymbolInfo } from "../../shared/types";

interface AtomicSymbolGraphProps {
  symbols: SymbolInfo[];
  dependencies: SymbolDependency[];
  incomingDependencies?: SymbolDependency[]; // External calls TO these symbols
  filePath: string;
  onNodeClick: (symbolId: string, line?: number) => void;
  onBackToProject: () => void;
}

interface TreeNode {
  id: string;
  name: string;
  kind: string;
  category: string;
  line: number;
  children: TreeNode[];
  isExpanded: boolean;
  dependsOn: string[];
  dependsFrom: string[];
}

/**
 * Hierarchical Tree View for Symbol Navigation
 * Like VS Code file explorer but for symbols
 */
export const AtomicSymbolGraph: React.FC<AtomicSymbolGraphProps> = ({
  symbols,
  dependencies,
  incomingDependencies = [],
  filePath,
  onNodeClick,
  onBackToProject,
}) => {
  // Debug logging
  React.useEffect(() => {
    console.log('[AtomicSymbolGraph] Component mounted/updated');
    console.log('[AtomicSymbolGraph] symbols:', symbols.length);
    if (symbols.length > 0) {
      console.log('[AtomicSymbolGraph] First 3 symbol IDs:', symbols.slice(0, 3).map(s => ({ name: s.name, id: s.id })));
    }
    console.log('[AtomicSymbolGraph] dependencies:', dependencies.length);
    console.log('[AtomicSymbolGraph] incomingDependencies:', incomingDependencies.length);
    if (incomingDependencies.length > 0) {
      console.log('[AtomicSymbolGraph] First 2 incoming dep targetSymbolIds:', incomingDependencies.slice(0, 2).map(d => ({ target: d.targetSymbolId })));
    }
  }, [symbols, dependencies, incomingDependencies]);

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    // Expand all classes by default
    const initialExpanded = new Set<string>();
    symbols.forEach(s => {
      if (s.category === 'class' || s.category === 'interface') {
        initialExpanded.add(s.id);
      }
    });
    return initialExpanded;
  });

  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // Build tree structure: classes contain methods
  const buildTree = (): TreeNode[] => {
    const nodeMap = new Map<string, TreeNode>();
    const depMap = buildDependencyMap();

    // Create nodes for all symbols
    symbols.forEach(symbol => {
      const depOn = depMap.dependsOn[symbol.id] || [];
      const depFrom = depMap.dependsFrom[symbol.id] || [];
      nodeMap.set(symbol.id, {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        category: symbol.category,
        line: symbol.line,
        children: [],
        isExpanded: expandedNodes.has(symbol.id),
        dependsOn: depOn,
        dependsFrom: depFrom,
      });
      if (depFrom.length > 0 || symbol.name === 'calculateDistance') {
        console.log('[buildTree] Node for', symbol.name, ':', {
          symbolId: symbol.id,
          depFromKeys: Object.keys(depMap.dependsFrom),
          depFrom: depFrom,
          depOn: depOn,
        });
      }
    });

    // Build hierarchy: add methods to their classes
    const rootNodes: TreeNode[] = [];
    symbols.forEach(symbol => {
      const parentId = symbol.parentSymbolId;
      const node = nodeMap.get(symbol.id)!;

      if (parentId && nodeMap.has(parentId)) {
        // This is a child (method/property of a class)
        nodeMap.get(parentId)!.children.push(node);
      } else {
        // This is a root (class, function, etc.)
        rootNodes.push(node);
      }
    });

    // Sort: classes first, then by name
    rootNodes.sort((a, b) => {
      if (a.category === 'class' && b.category !== 'class') return -1;
      if (a.category !== 'class' && b.category === 'class') return 1;
      return a.name.localeCompare(b.name);
    });

    rootNodes.forEach(node => {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
    });

    return rootNodes;
  };

  const buildDependencyMap = () => {
    const dependsOn: Record<string, string[]> = {};
    const dependsFrom: Record<string, string[]> = {};

    // Add outgoing dependencies (calls from current file)
    dependencies.forEach(dep => {
      if (!dependsOn[dep.sourceSymbolId]) dependsOn[dep.sourceSymbolId] = [];
      if (!dependsFrom[dep.targetSymbolId]) dependsFrom[dep.targetSymbolId] = [];

      dependsOn[dep.sourceSymbolId].push(dep.targetSymbolId);
      dependsFrom[dep.targetSymbolId].push(dep.sourceSymbolId);
    });

    console.log('[buildDependencyMap] After dependencies:', { dependsFromKeys: Object.keys(dependsFrom) });

    // Add incoming dependencies (calls FROM external files TO current file)
    // Store the FULL external symbol ID so we can navigate to it later
    incomingDependencies.forEach((dep, idx) => {
      console.log(`[buildDependencyMap] Incoming dep ${idx}: source='${dep.sourceSymbolId.split(':').pop()}' -> target='${dep.targetSymbolId.split(':').pop()}'`);
      if (!dependsFrom[dep.targetSymbolId]) dependsFrom[dep.targetSymbolId] = [];
      // Store the FULL source symbol ID (with file path) so we can navigate to it
      dependsFrom[dep.targetSymbolId].push(dep.sourceSymbolId);
    });

    console.log('[buildDependencyMap] Final dependsFrom keys:', Object.keys(dependsFrom));

    // Remove duplicates from all arrays
    Object.keys(dependsOn).forEach(key => {
      dependsOn[key] = Array.from(new Set(dependsOn[key]));
    });
    Object.keys(dependsFrom).forEach(key => {
      dependsFrom[key] = Array.from(new Set(dependsFrom[key]));
    });

    return { dependsOn, dependsFrom };
  };

  const toggleNode = (nodeId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  };

  const handleNodeClick = (node: TreeNode) => {
    setSelectedNode(node.id);
    onNodeClick(node.id, node.line);
  };

  const getIconForKind = (kind: string): string => {
    const icons: Record<string, string> = {
      class: '◆',
      interface: '◇',
      function: 'ƒ',
      method: 'ƒ',
      property: '→',
      variable: '○',
      constructor: '◆',
    };
    return icons[kind] || '•';
  };

  const getColorForCategory = (category: string): string => {
    const colors: Record<string, string> = {
      class: '#c084fc',
      interface: '#c084fc',
      function: '#60a5fa',
      method: '#4ade80',
      property: '#fbbf24',
      variable: '#fbbf24',
      constructor: '#f59e0b',
    };
    return colors[category] || '#94a3b8';
  };

  const getSymbolName = (id: string): string => {
    // Extract name from id (format: path/file.ts:symbolName)
    const parts = id.split(':');
    return parts.length > 1 ? parts[parts.length - 1] : id;
  };

  // Find a node by ID in the tree structure
  const findNodeById = (nodes: TreeNode[], id: string): TreeNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
    return null;
  };

  // Find node and all parent nodes to open to it
  const findPathToNode = (nodes: TreeNode[], targetId: string, path: string[] = []): string[] | null => {
    for (const node of nodes) {
      const newPath = [...path, node.id];
      if (node.id === targetId) return newPath;
      const found = findPathToNode(node.children, targetId, newPath);
      if (found) return found;
    }
    return null;
  };

  // Navigate to a symbol by clicking on it in dependencies
  const handleDependencyClick = (depId: string) => {
    const roots = buildTree();
    const targetNode = findNodeById(roots, depId);
    
    if (targetNode) {
      // Local symbol - find path and open all parents
      const path = findPathToNode(roots, depId);
      if (path) {
        const newExpanded = new Set(expandedNodes);
        // Add all parents to expanded (except the target itself)
        for (let i = 0; i < path.length - 1; i++) {
          newExpanded.add(path[i]);
        }
        setExpandedNodes(newExpanded);
      }
      
      // Select and navigate to the target
      setSelectedNode(depId);
      onNodeClick(depId, targetNode.line);
    } else {
      // External symbol - navigate to it (parent component will handle loading the file)
      // Use line 1 as default for external symbols
      setSelectedNode(depId);
      onNodeClick(depId, 1);
    }
  };

  const renderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isSelected = node.id === selectedNode;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedNodes.has(node.id);
    const showDeps = isSelected && (node.dependsOn.length > 0 || node.dependsFrom.length > 0);

    if (isSelected || node.dependsFrom.length > 0) {
      console.log('[renderNode]', node.name, {
        selected: isSelected,
        dependsOnLength: node.dependsOn.length,
        dependsOnList: node.dependsOn,
        dependsFromLength: node.dependsFrom.length,
        dependsFromList: node.dependsFrom,
        showDeps: showDeps,
      });
    }

    return (
      <div key={node.id}>
        {/* Main node */}
        <button
          style={{
            paddingTop: '6px',
            paddingBottom: '6px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            backgroundColor: isSelected ? 'rgba(100, 200, 100, 0.15)' : 'transparent',
            borderLeft: isSelected ? '3px solid #4ade80' : '3px solid transparent',
            paddingLeft: `${depth * 20 - 3}px`,
            color: isSelected ? '#4ade80' : 'var(--vscode-editor-foreground)',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            border: 'none',
            width: '100%',
            textAlign: 'left',
          }}
          onClick={() => handleNodeClick(node)}
          aria-label={`Symbol ${node.name}`}
        >
          {hasChildren && (
            <button
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                minWidth: '20px',
                cursor: 'pointer',
                fontSize: '12px',
                border: 'none',
                background: 'none',
                padding: 0,
                color: 'inherit',
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleNode(node.id);
              }}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
          {!hasChildren && <span style={{ width: '20px' }} />}

          <span
            style={{
              color: getColorForCategory(node.category),
              fontWeight: '700',
              marginRight: '4px',
            }}
          >
            {getIconForKind(node.kind)}
          </span>

          <span style={{ flex: 1, fontWeight: isSelected ? '600' : '500' }}>
            {node.name}
          </span>
        </button>

        {/* Dependencies detail - only when selected */}
        {showDeps && (
          <div
            style={{
              paddingLeft: `${depth * 20 + 20}px`,
              paddingTop: '4px',
              paddingBottom: '4px',
              fontSize: '11px',
              color: '#999',
              fontStyle: 'italic',
            }}
          >
            {/* Who this calls */}
            {node.dependsOn.length > 0 && (
              <div style={{ marginBottom: '4px' }}>
                <span style={{ color: '#4ade80', fontWeight: '600' }}>→ calls:</span>
                {' '}
                {node.dependsOn.map((id, idx) => (
                  <span key={id}>
                    <button
                      onClick={() => handleDependencyClick(id)}
                      style={{
                        color: '#4ade80',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        fontWeight: '500',
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        font: 'inherit',
                      }}
                      title="Click to navigate"
                      aria-label={`Navigate to ${getSymbolName(id)}`}
                    >
                      {getSymbolName(id)}
                    </button>
                    {idx < node.dependsOn.length - 1 && ', '}
                  </span>
                ))}
              </div>
            )}

            {/* Who calls this */}
            {node.dependsFrom.length > 0 && (
              <div>
                <span style={{ color: '#60a5fa', fontWeight: '600' }}>← called by:</span>
                {' '}
                {node.dependsFrom.map((id, idx) => (
                  <span key={id}>
                    <button
                      onClick={() => handleDependencyClick(id)}
                      style={{
                        color: '#60a5fa',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        fontWeight: '500',
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        font: 'inherit',
                      }}
                      title="Click to navigate"
                      aria-label={`Navigate to ${getSymbolName(id)}`}
                    >
                      {getSymbolName(id)}
                    </button>
                    {idx < node.dependsFrom.length - 1 && ', '}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Children */}
        {isExpanded && hasChildren && (
          <div>
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const tree = buildTree();
  const fileName = filePath.split("/").pop() || "symbol-view";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--vscode-editor-background)",
        color: "var(--vscode-editor-foreground)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          fontSize: "12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <button
          onClick={onBackToProject}
          style={{
            padding: "4px 8px",
            background: "var(--vscode-button-background)",
            color: "white",
            border: "none",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "12px",
          }}
        >
          ← Back
        </button>
        <span style={{ fontWeight: '600' }}>{fileName}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {symbols.length} symbols
        </span>
      </div>

      {/* Tree View */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px",
          fontSize: "13px",
        }}
      >
        {tree.length === 0 ? (
          <div style={{ opacity: 0.5, padding: "16px" }}>No symbols found</div>
        ) : (
          tree.map(node => renderNode(node))
        )}
      </div>

      {/* Stats Footer */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid var(--vscode-panel-border)",
          fontSize: "11px",
          opacity: 0.7,
        }}
      >
        {dependencies.length} relations • {tree.length} root symbols
      </div>
    </div>
  );
};
