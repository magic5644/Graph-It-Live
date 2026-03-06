/**
 * Entry point for the Call Graph webview panel.
 *
 * This is bundled separately as dist/callgraph.js and loaded by
 * CallGraphViewService when creating the call graph WebviewPanel.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { CytoscapeGraph } from "../components/cytoscape/CytoscapeGraph";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <CytoscapeGraph />
    </React.StrictMode>,
  );
}
