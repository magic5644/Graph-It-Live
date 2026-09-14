import React from 'react';

export interface CommunityEntry {
  id: number;
  label: string; // Functional directory domain, or a fallback for legacy data.
  color: string; // communityColor(id)
  key?: string;
  count?: number;
}

interface CommunityLegendProps {
  communities: CommunityEntry[];
  excluded?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  onShowAll?: () => void;
}

export function CommunityLegend({ communities, excluded, onToggle, onShowAll }: Readonly<CommunityLegendProps>): React.JSX.Element | null {
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
        <div style={{ opacity: 0.75, fontSize: 10, marginTop: 2 }}>Groups based on folders</div>
        {onShowAll && <button type="button" onClick={onShowAll}>Show all</button>}
      </div>
      {communities.map(({ id, label, color, key, count }) => (
        <label key={key ?? id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          {onToggle && key !== undefined && <input
            type="checkbox"
            checked={!excluded?.has(key)}
            aria-label={`${label} (${count ?? 0})`}
            onChange={() => onToggle(key)}
          />}
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
          {count !== undefined && <span style={{ opacity: 0.75 }}>({count})</span>}
        </label>
      ))}
    </div>
  );
}
