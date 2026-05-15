import React from "react";
import mermaid from "mermaid";
import html2canvas from "html2canvas";

type Props = Readonly<{
  mermaidCode: string;
}>;

export function MermaidRenderer({ mermaidCode }: Props): React.JSX.Element {
  const svgRef = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const renderMermaid = async () => {
      if (!svgRef.current) return;

      try {
        setError(null);
        // Initialize mermaid
        mermaid.initialize({ startOnLoad: true, theme: "dark" });

        // Clear previous content
        svgRef.current.innerHTML = "";

        // Create unique ID for this diagram
        const diagramId = `mermaid-${Date.now()}`;

        // Create container div with mermaid class
        const container = document.createElement("div");
        container.className = "mermaid";
        container.id = diagramId;
        container.textContent = mermaidCode;

        // Append and render
        svgRef.current.appendChild(container);
        mermaid.run();
      } catch (err) {
        setError(`Failed to render diagram: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    renderMermaid();
  }, [mermaidCode]);

  const exportSVG = React.useCallback(() => {
    if (!svgRef.current) return;

    const svg = svgRef.current.querySelector("svg");
    if (!svg) {
      alert("SVG not ready");
      return;
    }

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svg);
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "sequence-diagram.svg";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, []);

  const exportPNG = React.useCallback(async () => {
    if (!svgRef.current) return;

    try {
      const svg = svgRef.current.querySelector("svg");
      if (!svg) {
        alert("SVG not ready");
        return;
      }

      // Create a wrapper div for html2canvas
      const wrapper = document.createElement("div");
      wrapper.style.backgroundColor = "#1e1e1e";
      wrapper.style.display = "inline-block";
      wrapper.appendChild(svg.cloneNode(true));

      const canvas = await html2canvas(wrapper, {
        backgroundColor: "#1e1e1e",
        scale: 2,
      });

      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = "sequence-diagram.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      alert(`Failed to export PNG: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const exportMermaid = React.useCallback(() => {
    const blob = new Blob([mermaidCode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "sequence-diagram.mmd";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [mermaidCode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={exportSVG} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export SVG
        </button>
        <button type="button" onClick={exportPNG} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export PNG
        </button>
        <button type="button" onClick={exportMermaid} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export Mermaid
        </button>
      </div>

      {error && <div style={{ color: "var(--vscode-errorForeground)", fontSize: 12 }}>{error}</div>}

      <div
        ref={svgRef}
        style={{
          minHeight: 0,
          overflow: "auto",
          border: "1px solid var(--vscode-widget-border)",
          borderRadius: 6,
          padding: 8,
          flex: 1,
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-start",
        }}
      />
    </div>
  );
}
