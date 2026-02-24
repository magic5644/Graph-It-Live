import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { CATEGORY_ICONS, getSymbolStyle } from '../../utils/symbolUtils';

export interface SymbolNodeData {
    label: string;
    fullPath: string; // The ID of the symbol (path:name)
    kind: string; // 'Function', 'Class', etc.
    category: string; // 'function', 'class', etc.
    line: number;
    isExported: boolean;
    isRoot: boolean;
    isExternal?: boolean; // T090: External symbols from other files (imports)
    onNodeClick: () => void;
    onDrillDown: () => void;
    onHighlight?: (symbolId: string) => void; // Étape 4: Highlight handler for double-click
    // Expansion props
    hasChildren?: boolean;
    isExpanded?: boolean;
    onToggle?: () => void;
    onExpandRequest?: () => void;
    selectedNodeId?: string | null;
    nodeId?: string;
    // Étape 4: Highlight state
    isHighlighted?: boolean;
    isHighlightActive?: boolean; // Whether highlight mode is active
}

const actionButtonSize = 20;

export const SymbolNode: React.FC<NodeProps<SymbolNodeData>> = ({ data, id }) => {
    const style = getSymbolStyle(data.category);
    const icon = CATEGORY_ICONS[data.category] || '?';

    // T090: Apply dimming style for external references (FR-022)
    const isExternal = data.isExternal ?? false;
    
    // Étape 4: Determine opacity based on highlight state
    let opacity = 1;
    if (isExternal) {
        opacity = 0.5;
    } else if (data.isHighlightActive && !data.isHighlighted) {
        opacity = 0.3; // Dim non-highlighted nodes when highlight is active
    }
    
    const borderStyle = isExternal ? 'dashed' : 'solid';
    const isSelected = data.selectedNodeId === (data.nodeId || id);

    // Handle single-click to navigate to symbol in code
    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        data.onNodeClick();
    };

    // Étape 4: Handle double-click to highlight related nodes
    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (data.onHighlight) {
            data.onHighlight(data.nodeId || id);
        } else {
            // Fallback to drill down if no highlight handler
            data.onDrillDown();
        }
    };

    // Determine box shadow based on state
    const getBoxShadow = () => {
        if (isSelected) return '0 0 8px rgba(0, 120, 212, 0.5)';
        if (data.isHighlighted) return '0 0 12px rgba(16, 185, 129, 0.6)'; // Étape 4: Green glow for highlighted
        if (data.isRoot) return '0 0 10px rgba(0,0,0,0.2)';
        return 'none';
    };
    
    // Étape 4: Determine border style based on highlight state
    const getBorder = () => {
        if (data.isHighlighted) {
            return '3px solid #10b981'; // Green border for highlighted nodes
        }
        if (isSelected) {
            return '4px solid #0078d4';
        }
        return `2px ${borderStyle} ${style.border}`;
    };

    return (
        <button
            type="button"
            style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: data.isRoot ? style.bg : 'var(--vscode-editor-background)',
                border: getBorder(),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: getBoxShadow(),
                cursor: 'pointer',
                opacity,
                padding: 0,
            }}
            title={`${data.kind}: ${data.label} (Line ${data.line})${isExternal ? ' [External]' : ''}${isSelected ? ' [Selected]' : ''}${data.isHighlighted ? ' [Highlighted]' : ''}`}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleClick(e as unknown as React.MouseEvent);
                }
            }}
        >
            <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />

            <div style={{
                fontSize: 14,
                fontWeight: 'bold',
                color: data.isRoot ? style.text : 'var(--vscode-editor-foreground)',
            }}>
                {icon}
            </div>

            {/* Label below the node */}
            <div style={{
                position: 'absolute',
                top: 42,
                left: '50%',
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
                fontSize: 10,
                color: 'var(--vscode-editor-foreground)',
                background: 'var(--vscode-editor-background)',
                padding: '2px 4px',
                borderRadius: 4,
                border: '1px solid var(--vscode-widget-border)',
                zIndex: 10,
                pointerEvents: 'none',
                fontStyle: isExternal ? 'italic' : 'normal',
                opacity,
            }}>
                {data.label}
            </div>

            {
                data.isExported && (
                    <div style={{
                        position: 'absolute',
                        top: -4,
                        right: -4,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--vscode-badge-background)',
                        border: '1px solid var(--vscode-editor-background)',
                    }} title="Exported" />
                )
            }

            {/* Expansion Button */}
            {data.hasChildren && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        if (data.isExpanded) data.onToggle?.();
                        else data.onExpandRequest?.();
                    }}
                    aria-label={data.isExpanded ? 'Collapse node' : 'Expand node'}
                    style={{
                        position: 'absolute',
                        right: -(actionButtonSize / 2),
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: actionButtonSize,
                        height: actionButtonSize,
                        borderRadius: '50%',
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 14,
                        zIndex: 10,
                        pointerEvents: 'auto',
                        border: '2px solid var(--vscode-editor-background)',
                        padding: 0,
                    }}
                >
                    {data.isExpanded ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14" />
                        </svg>
                    ) : (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    )}
                </button>
            )}

            <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
        </button >
    );
};
