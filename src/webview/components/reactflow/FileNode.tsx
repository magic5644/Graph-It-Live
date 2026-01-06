import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { actionButtonSize, cycleIndicatorSize } from '../../utils/nodeUtils';
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
  onDrillDown: () => void;
  onFindReferences: () => void;
  onToggleParents?: () => void;
  onToggle: () => void;
  onExpandRequest: () => void;
}

// File type specific border colors
const FILE_TYPE_COLORS: Record<string, string> = {
  '.ts': '#3178c6',
  '.tsx': '#3178c6',
  '.js': '#f7df1e',
  '.jsx': '#f7df1e',
  '.vue': '#41b883',
  '.svelte': '#ff3e00',
  '.gql': '#e535ab',
  '.graphql': '#e535ab',
  '.py': '#3776ab',      // Python blue
  '.pyi': '#3776ab',     // Python interface files
  '.rs': '#ce422b',      // Rust orange
  '.toml': '#9c4221',    // TOML brown
};

const EXTERNAL_PACKAGE_COLOR = '#6b6b6b';

function isExternalPackage(path: string): boolean {
  if (!path) return false;

  for (const ext of Object.keys(FILE_TYPE_COLORS)) {
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

function getFileBorderColor(label: string, fullPath: string): string {
  if (isExternalPackage(fullPath || label)) {
    return EXTERNAL_PACKAGE_COLOR;
  }
  for (const [ext, color] of Object.entries(FILE_TYPE_COLORS)) {
    if (label.endsWith(ext)) return color;
  }
  return EXTERNAL_PACKAGE_COLOR;
}

export const FileNode: React.FC<NodeProps> = ({ data }: NodeProps<FileNodeData>) => {
  const borderColor = getFileBorderColor(data.label, data.fullPath);
  const isExternal = isExternalPackage(data.fullPath || data.label);

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      title={data.fullPath}
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
          background: data.isRoot ? borderColor : 'var(--vscode-editor-background)',
          color: data.isRoot ? '#000' : 'var(--vscode-editor-foreground)',
          border: isExternal ? `2px dashed ${borderColor}` : `2px solid ${borderColor}`,
          borderRadius: 4,
          padding: '0 12px',
          fontSize: 12,
          fontWeight: data.isRoot ? 'bold' : 'normal',
          fontStyle: isExternal ? 'italic' : 'normal',
          fontFamily: 'var(--vscode-font-family)',
          pointerEvents: 'none',
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
    </div>
  );
};

