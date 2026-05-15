import React from "react";
import type { SequenceModelPayload } from "../../../shared/messages";
import { MermaidRenderer } from "./MermaidRenderer";

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

  React.useEffect(() => {
    setSymbol(symbolName);
  }, [symbolName]);

  React.useEffect(() => {
    setDepth(maxDepth);
  }, [maxDepth]);

  React.useEffect(() => {
    setSteps(maxSteps);
  }, [maxSteps]);

  const handleGenerate = React.useCallback(() => {
    onGenerate({
      filePath,
      symbolName: symbol,
      maxDepth: depth,
      maxSteps: steps,
    });
  }, [depth, filePath, onGenerate, steps, symbol]);

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
          max={20}
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
      </div>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Root: <code>{filePath}#{symbolName}</code>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minHeight: 0, flex: 1 }}>
        <div style={{ minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <MermaidRenderer mermaidCode={mermaid} />
        </div>

        <div style={{ minHeight: 0, overflow: "auto", border: "1px solid var(--vscode-widget-border)", borderRadius: 6, padding: 8 }}>
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
      </div>
    </div>
  );
}
