import React from 'react';

export interface ExpansionState {
  nodeId: string;
  status: 'started' | 'in-progress' | 'completed' | 'cancelled' | 'error';
  processed?: number;
  total?: number;
  message?: string;
}

export const ExpansionOverlay: React.FC<{
  state: ExpansionState;
  onCancel?: (nodeId?: string) => void;
}> = ({ state, onCancel }) => {
  const isRunning = state.status === 'started' || state.status === 'in-progress';
  const processed = typeof state.processed === 'number' ? state.processed : undefined;
  const total = typeof state.total === 'number' ? state.total : undefined;
  const showTotals = (typeof processed === 'number' && processed > 0) || (typeof total === 'number' && total > 0);

  const statusLabel: string = (() => {
    switch (state.status) {
      case 'started':
      case 'in-progress':
        return 'Expansion en cours';
      case 'completed':
        return 'Expansion terminée';
      case 'cancelled':
        return 'Expansion annulée';
      case 'error':
        return 'Erreur pendant l’expansion';
      default:
        return 'Expansion';
    }
  })();

  const fileLabel = state.nodeId.split(/[/\\]/).pop() || state.nodeId;

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 6,
        background: 'var(--vscode-editor-background)',
        border: '1px solid var(--vscode-focusBorder)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
        minWidth: 260,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '2px solid var(--vscode-editor-foreground)',
            borderTopColor: 'transparent',
            animation: isRunning ? 'gil-spin 0.9s linear infinite' : 'none',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{statusLabel}</span>
          <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>{fileLabel}</span>
          {showTotals && (
            <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
              {typeof processed === 'number' ? processed : '?'}
              {typeof total === 'number' ? ` / ${total}` : ''}
            </span>
          )}
          {!showTotals && isRunning && (
            <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
              Découverte des dépendances…
            </span>
          )}
          {state.message && (
            <span
              style={{
                fontSize: 12,
                color: state.status === 'error' ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)',
              }}
            >
              {state.message}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onCancel?.(state.nodeId)}
        disabled={!isRunning}
        style={{
          padding: '6px 10px',
          borderRadius: 4,
          border: '1px solid var(--vscode-button-border, transparent)',
          background: isRunning ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
          color: isRunning ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
          cursor: isRunning ? 'pointer' : 'not-allowed',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Annuler
      </button>
    </div>
  );
};

