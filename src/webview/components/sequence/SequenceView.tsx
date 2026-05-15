import React from "react";
import type { SequenceModelPayload } from "../../../shared/messages";
import { MermaidRenderer } from "./MermaidRenderer";

type SequenceWarningPayload = SequenceModelPayload["warnings"][number];

type Props = Readonly<{
  mermaid: string;
  model: SequenceModelPayload;
  filePath: string;
  symbolName: string;
  maxDepth: number;
  maxSteps: number;
  onGenerate: (input: {
    filePath: string;
    symbolName: string;
    maxDepth: number;
    maxSteps: number;
  }) => void;
  onOpenFile: (path: string, line: number) => void;
}>;

function summarizeWarningCounts(warnings: SequenceWarningPayload[]): string {
  const countsByCode = new Map<string, number>();
  for (const warning of warnings) {
    countsByCode.set(warning.code, (countsByCode.get(warning.code) ?? 0) + 1);
  }

  return Array.from(countsByCode.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => count === 1 ? code : `${code} x${count}`)
    .join(", ");
}

function compactSymbolId(symbolId: string): string {
  const suffix = symbolId.split(":").at(-1);
  return suffix && suffix.length > 0 ? suffix : symbolId;
}

function compactWarningMessage(warning: SequenceWarningPayload): string {
  if (warning.code === "AMBIGUOUS_TARGET") {
    const resolved = /Resolved method name '([^']+)' to '([^']+)'/.exec(warning.message);
    if (resolved?.[1] && resolved[2]) {
      return `Resolved ${resolved[1]} -> ${compactSymbolId(resolved[2])}`;
    }

    const selected = /Using '([^']+)'/.exec(warning.message);
    if (selected?.[1]) {
      return `Using ${compactSymbolId(selected[1])}`;
    }

    if (warning.message.includes("Used class-level dependencies")) {
      return "Using class-level dependencies";
    }
  }

  if (warning.message.length <= 140) return warning.message;
  return `${warning.message.slice(0, 137)}...`;
}

export function SequenceView({
  mermaid,
  model,
  filePath,
  symbolName,
  maxDepth,
  maxSteps,
  onGenerate,
  onOpenFile,
}: Props): React.JSX.Element {
  const [symbol, setSymbol] = React.useState(symbolName);
  const [depth, setDepth] = React.useState(maxDepth);
  const [steps, setSteps] = React.useState(maxSteps);
  const [showMessages, setShowMessages] = React.useState(false);
  const onGenerateRef = React.useRef(onGenerate);
  const warningSummary = React.useMemo(
    () => summarizeWarningCounts(model.warnings),
    [model.warnings],
  );

  React.useEffect(() => {
    onGenerateRef.current = onGenerate;
  }, [onGenerate]);

  React.useEffect(() => {
    setSymbol(symbolName);
  }, [symbolName]);

  React.useEffect(() => {
    setDepth(Math.max(1, model.stats.maxDepthReached || maxDepth));
  }, [maxDepth, model.stats.maxDepthReached]);

  React.useEffect(() => {
    setSteps(maxSteps);
  }, [maxSteps]);

  const handleGenerate = React.useCallback(() => {
    onGenerateRef.current({
      filePath,
      symbolName: symbol,
      maxDepth: depth,
      maxSteps: steps,
    });
  }, [depth, filePath, steps, symbol]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="sequence-symbol" style={{ fontSize: 12 }}>Symbol</label>
        <input
          id="sequence-symbol"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{ minWidth: 220 }}
        />

        <label htmlFor="sequence-depth" style={{ fontSize: 12 }}>Depth</label>
        <input
          id="sequence-depth"
          type="number"
          min={1}
          max={Math.max(20, depth)}
          value={depth}
          onChange={(e) => setDepth(Number.parseInt(e.target.value, 10) || 1)}
          style={{ width: 72 }}
        />

        <label htmlFor="sequence-steps" style={{ fontSize: 12 }}>Steps</label>
        <input
          id="sequence-steps"
          type="number"
          min={1}
          max={1000}
          value={steps}
          onChange={(e) => setSteps(Number.parseInt(e.target.value, 10) || 1)}
          style={{ width: 88 }}
        />

        <button type="button" onClick={handleGenerate}>Generate</button>
        <button
          type="button"
          onClick={() => setShowMessages((value) => !value)}
        >
          {showMessages ? "Focus Diagram" : "Show Messages"}
        </button>
      </div>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Root: <code>{filePath}#{symbolName}</code>
      </div>

      {(model.truncated || model.warnings.length > 0) && (
        <div
          style={{
            fontSize: 12,
            border: "1px solid var(--vscode-editorWarning-foreground)",
            borderRadius: 6,
            padding: "6px 8px",
            color: "var(--vscode-editorWarning-foreground)",
          }}
        >
          {model.truncated ? "Sequence truncated by limits. " : ""}
          {model.warnings.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer" }}>
                Warnings: {warningSummary || model.warnings.length}
              </summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 16, maxHeight: 120, overflow: "auto" }}>
                {model.warnings.map((warning, index) => (
                  <li
                    key={`${warning.code}-${index}`}
                    title={warning.message}
                    style={{ marginBottom: 4, overflowWrap: "anywhere" }}
                  >
                    <strong>{warning.code}</strong>: {compactWarningMessage(warning)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showMessages ? "minmax(0, 2fr) minmax(320px, 1fr)" : "minmax(0, 1fr)",
          gap: 12,
          minHeight: 0,
          flex: 1,
        }}
      >
        <div style={{ minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <MermaidRenderer
            mermaidCode={mermaid}
            model={model}
            onOpenFile={onOpenFile}
          />
        </div>

        {showMessages && (
          <div
            style={{
              minHeight: 0,
              overflow: "auto",
              border: "1px solid var(--vscode-widget-border)",
              borderRadius: 6,
              padding: 8,
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 8, fontWeight: 600 }}>
              Messages ({model.messages.length})
            </div>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {model.messages.map((message) => (
                <li key={message.id} style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(message.sourceFile, message.startLine + 1)}
                    style={{ all: "unset", cursor: "pointer", color: "var(--vscode-textLink-foreground)" }}
                  >
                    {message.label || `${message.fromParticipantId} -> ${message.toParticipantId}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
