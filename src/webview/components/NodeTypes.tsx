import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface FileNodeData {
  label: string;
  filePath: string;
  fileType: 'ts' | 'tsx' | 'js' | 'jsx' | 'node_module' | 'other';
}

const getNodeColor = (fileType: FileNodeData['fileType']): string => {
  switch (fileType) {
    case 'ts':
    case 'tsx':
      return '#3178c6'; // TypeScript blue
    case 'js':
    case 'jsx':
      return '#f7df1e'; // JavaScript yellow
    case 'node_module':
      return '#999999'; // Grey
    default:
      return '#cccccc';
  }
};

export const FileNode: React.FC<NodeProps<FileNodeData>> = ({ data }) => {
  const color = getNodeColor(data.fileType);

  return (
    <div
      style={{
        padding: '10px 15px',
        borderRadius: '5px',
        background: color,
        color: data.fileType === 'js' || data.fileType === 'jsx' ? '#000' : '#fff',
        border: '2px solid #222',
        fontSize: '12px',
        fontFamily: 'monospace',
        minWidth: '100px',
        textAlign: 'center',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ fontWeight: 'bold' }}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
};

export const nodeTypes = {
  fileNode: FileNode,
};
