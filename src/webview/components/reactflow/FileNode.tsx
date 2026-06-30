import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { EXTENSION_COLORS, LANGUAGE_COLORS } from '../../../shared/constants';
import { actionButtonSize, cycleIndicatorSize } from '../../utils/nodeUtils';
import { communityColor } from '../../utils/communityColor';
import { LanguageIcon } from './LanguageIcon';

export interface FileNodeData {
  label: string;
  fullPath: string;
  isRoot: boolean;
  isParent: boolean;
  isInCycle: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
  hasReferencingFiles: boolean;
  parentCount?: number;
  isParentsVisible: boolean;
  hubScore?: number; // 0-100, undefined en mode symbol
  communityId?: number;
  onNodeClick: () => void;
  onDrillDown: () => void;
  onFindReferences: () => void;
  onToggleParents?: () => void;
  onToggle: () => void;
  onExpandRequest: () => void;
  selectedNodeId?: string | null;
  nodeId?: string;
}

// Use shared extension colors from constants
const EXTERNAL_PACKAGE_COLOR = LANGUAGE_COLORS.unknown;

function isExternalPackage(path: string): boolean {
  if (!path) return false;

  for (const ext of Object.keys(EXTENSION_COLORS)) {
    if (path.endsWith(ext)) return false;
  }

  if (path.startsWith('.') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    return false;
  }

  if ((path.includes('/') || path.includes('\\')) && !path.includes('node_modules')) {
    return false;
  }

  return true;
}

export function getHubBorderWidth(score: number | undefined): number {
  if (score === undefined) return 2;
  if (score >= 80) return 5;
  if (score >= 50) return 4;
  if (score >= 20) return 3;
  return 2;
}

function getFileBorderColor(label: string, fullPath: string): string {
  if (isExternalPackage(fullPath || label)) {
    return EXTERNAL_PACKAGE_COLOR;
  }
  for (const [ext, color] of Object.entries(EXTENSION_COLORS)) {
    if (label.endsWith(ext)) return color;
  }
  return EXTERNAL_PACKAGE_COLOR;
}

export const FileNode = React.memo<NodeProps<FileNodeData>>(function FileNode({ data, id }) {
  const borderColor = getFileBorderColor(data.label, data.fullPath);
  const isExternal = isExternalPackage(data.fullPath || data.label);
  const isSelected = data.selectedNodeId === (data.nodeId || id);

  // Handle single-click to open file in VS Code
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onNodeClick();
  };

  // Handle double-click to drill down (keep existing behavior)
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onDrillDown();
  };

  // Handle keyboard interactions for accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      handleClick(e as unknown as React.MouseEvent);
    }
  };

  return (
    <button
      type="button"
      style={{ 
        position: 'relative', 
        width: '100%', 
        height: '100%',
        border: 'none',
        padding: 0,
        background: 'transparent',
        cursor: 'pointer'
      }}
      title={data.fullPath}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />

      {/* Language icon in top-left corner */}
      <LanguageIcon filePath={data.fullPath} label={data.label} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: data.isRoot
            ? borderColor
            : (() => {
                const commBg = communityColor(data.communityId);
                return commBg !== 'transparent' ? commBg + '22' : 'var(--vscode-editor-background)';
              })(),
          color: data.isRoot ? '#000' : 'var(--vscode-editor-foreground)',
          border: (() => {
            if (isSelected) return '4px solid #0078d4';
            const width = getHubBorderWidth(data.hubScore);
            const style = isExternal ? 'dashed' : 'solid';
            return `${width}px ${style} ${borderColor}`;
          })(),
          borderRadius: 4,
          padding: '0 12px',
          fontSize: (!data.isRoot && (data.hubScore ?? 0) >= 80) ? 13 : 12,
          fontWeight: data.isRoot ? 'bold' : (data.hubScore ?? 0) >= 50 ? 'bold' : 'normal',
          fontStyle: isExternal ? 'italic' : 'normal',
          fontFamily: 'var(--vscode-font-family)',
          pointerEvents: 'none',
          boxShadow: isSelected ? '0 0 8px rgba(0, 120, 212, 0.5)' : 'none',
        }}
      >
        {data.label}
      </div>

      {data.isInCycle && (
        <div
          style={{
            position: 'absolute',
            top: -(cycleIndicatorSize / 2),
            right: -(cycleIndicatorSize / 2),
            width: cycleIndicatorSize,
            height: cycleIndicatorSize,
            borderRadius: '50%',
            background: '#dc3545',
            border: '2px solid var(--vscode-editor-background)',
            zIndex: 15,
            pointerEvents: 'none',
          }}
          title="Part of circular dependency"
        />
      )}

      {data.hasChildren && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (data.isExpanded) data.onToggle();
            else data.onExpandRequest();
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
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
            </svg>
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          )}
        </button>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          data.onDrillDown();
        }}
        aria-label="View symbols"
        title="View symbols"
        style={{
          position: 'absolute',
          right: -(actionButtonSize / 2),
          bottom: -(actionButtonSize / 2),
          width: actionButtonSize,
          height: actionButtonSize,
          borderRadius: '50%',
          background: 'var(--vscode-button-secondaryBackground)',
          color: 'var(--vscode-button-secondaryForeground)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 'bold',
          zIndex: 10,
          pointerEvents: 'auto',
          border: '2px solid var(--vscode-editor-background)',
          padding: 0,
        }}
      >
        ✨
      </button>

      {data.isRoot && data.hasReferencingFiles && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleParents?.();
          }}
          aria-label={data.isParentsVisible ? 'Hide referencing files' : 'Show referencing files'}
          title={data.isParentsVisible ? 'Hide referencing files' : 'Show referencing files'}
          style={{
            position: 'absolute',
            left: -(actionButtonSize + 4),
            top: '50%',
            transform: 'translateY(-50%)',
            width: actionButtonSize,
            height: actionButtonSize,
            borderRadius: '50%',
            background: 'var(--vscode-button-secondaryBackground)',
            color: 'var(--vscode-button-secondaryForeground)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 10,
            fontWeight: 'bold',
            zIndex: 10,
            pointerEvents: 'auto',
            border: '2px solid var(--vscode-editor-background)',
            padding: 0,
          }}
        >
          {data.isParentsVisible ? '◀' : '▶'}
        </button>
      )}

      <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
    </button>
  );
},
// Custom comparator: compare only data props, never callback props.
// Callbacks change reference on every parent render and would cause constant re-renders.
(prev, next) => {
  const pd = prev.data;
  const nd = next.data;
  return (
    prev.id === next.id &&
    pd.label === nd.label &&
    pd.fullPath === nd.fullPath &&
    pd.isRoot === nd.isRoot &&
    pd.isParent === nd.isParent &&
    pd.isInCycle === nd.isInCycle &&
    pd.hasChildren === nd.hasChildren &&
    pd.isExpanded === nd.isExpanded &&
    pd.hasReferencingFiles === nd.hasReferencingFiles &&
    pd.parentCount === nd.parentCount &&
    pd.isParentsVisible === nd.isParentsVisible &&
    pd.hubScore === nd.hubScore &&
    pd.communityId === nd.communityId &&
    pd.selectedNodeId === nd.selectedNodeId &&
    pd.nodeId === nd.nodeId
  );
});
