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
    onDrillDown: () => void;
    // Expansion props
    hasChildren?: boolean;
    isExpanded?: boolean;
    onToggle?: () => void;
    onExpandRequest?: () => void;
}

const actionButtonSize = 20;

export const SymbolNode: React.FC<NodeProps<SymbolNodeData>> = ({ data }) => {
    const style = getSymbolStyle(data.category);
    const icon = CATEGORY_ICONS[data.category] || '?';

    // T090: Apply dimming style for external references (FR-022)
    const isExternal = data.isExternal ?? false;
    const opacity = isExternal ? 0.5 : 1.0;
    const borderStyle = isExternal ? 'dashed' : 'solid';

    return (
        <div
            style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: data.isRoot ? style.bg : 'var(--vscode-editor-background)',
                border: `2px ${borderStyle} ${style.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: data.isRoot ? '0 0 10px rgba(0,0,0,0.2)' : 'none',
                cursor: 'pointer',
                opacity,
            }}
            title={`${data.kind}: ${data.label} (Line ${data.line})${isExternal ? ' [External]' : ''}`}
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
        </div >
    );
};
