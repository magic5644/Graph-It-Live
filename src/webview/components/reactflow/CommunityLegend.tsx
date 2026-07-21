import React from 'react';

export interface CommunityEntry {
  id: number;
  label: string; // basename of the node with the highest hubScore
  color: string; // communityColor(id)
}

interface CommunityLegendProps {
  communities: CommunityEntry[];
}

export function CommunityLegend({ communities }: CommunityLegendProps) {
  if (communities.length === 0) return null;

  return (
    <div style={{
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-editorWidget-border, #333)',
      borderRadius: 4,
      padding: '6px 10px',
      fontSize: 11,
      color: 'var(--vscode-editor-foreground)',
      opacity: 0.9,
      maxHeight: 200,
      overflowY: 'auto',
    }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 'bold', opacity: 0.9, lineHeight: 1.2 }}>Import clusters</div>
        <div style={{ opacity: 0.55, fontSize: 10, marginTop: 2 }}>Groups of closely connected files</div>
      </div>
      {communities.map(({ id, label, color }) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <div
            data-testid={`community-swatch-${id}`}
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: color,
              flexShrink: 0,
            }}
          />
          <span title={`Cluster ${id} — ${communities.length} clusters total`}>{label}</span>
        </div>
      ))}
    </div>
  );
}
