import React from "react";
import { createRoot } from "react-dom/client";
import { SequenceView } from "../components/sequence/SequenceView";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <SequenceView
        mermaid="sequenceDiagram"
        model={{
          root: { id: "root", symbolName: "main", filePath: "" },
          participants: [],
          messages: [],
          warnings: [],
          truncated: false,
          stats: { participantsCount: 0, messagesCount: 0, maxDepthReached: 0, analysisTimeMs: 0 },
        }}
        filePath=""
        symbolName="main"
        maxDepth={6}
        maxSteps={200}
        onGenerate={() => {}}
        onOpenFile={() => {}}
      />
    </React.StrictMode>,
  );
}
