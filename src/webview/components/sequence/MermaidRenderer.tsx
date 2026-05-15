import React from "react";
import mermaid from "mermaid";
import type { SequenceModelPayload } from "../../../shared/messages";

type Props = Readonly<{
  mermaidCode: string;
  model: SequenceModelPayload;
  onOpenFile: (path: string, line: number) => void;
}>;

type SourceLocation = {
  path: string;
  line: number;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
};

const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 300;
const ZOOM_STEP_PERCENT = 10;

function clampZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.trunc(value)));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function buildParticipantLocationIndex(
  model: SequenceModelPayload,
): Map<string, SourceLocation> {
  const locationByParticipantId = new Map<string, SourceLocation>();

  for (const message of model.messages) {
    if (!locationByParticipantId.has(message.fromParticipantId)) {
      locationByParticipantId.set(message.fromParticipantId, {
        path: message.sourceFile,
        line: message.startLine + 1,
      });
    }
    if (!locationByParticipantId.has(message.toParticipantId)) {
      locationByParticipantId.set(message.toParticipantId, {
        path: message.sourceFile,
        line: message.startLine + 1,
      });
    }
  }

  const locationByLabel = new Map<string, SourceLocation>();
  for (const participant of model.participants) {
    const fromMessages = locationByParticipantId.get(participant.id);
    const fallbackLocation = participant.filePath
      ? { path: participant.filePath, line: 1 }
      : null;
    const resolved = fromMessages ?? fallbackLocation;
    if (!resolved) continue;

    locationByLabel.set(normalizeLabel(participant.label), resolved);
    locationByLabel.set(normalizeLabel(participant.id), resolved);
  }

  return locationByLabel;
}

function createClickCleanup(
  node: SVGTextElement,
  location: SourceLocation,
  onOpenFile: (path: string, line: number) => void,
): () => void {
  const clickable = node as unknown as HTMLElement;
  const previousCursor = clickable.style.cursor;
  clickable.style.cursor = "pointer";
  clickable.style.textDecoration = "underline";

  const onClick = () => {
    onOpenFile(location.path, location.line);
  };

  clickable.addEventListener("click", onClick);

  return () => {
    clickable.removeEventListener("click", onClick);
    clickable.style.cursor = previousCursor;
    clickable.style.textDecoration = "";
  };
}

function bindParticipantClicks(
  container: HTMLDivElement,
  model: SequenceModelPayload,
  onOpenFile: (path: string, line: number) => void,
): Array<() => void> {
  const locationByLabel = buildParticipantLocationIndex(model);
  if (locationByLabel.size === 0) return [];

  const candidates = container.querySelectorAll<SVGTextElement>(
    "svg text.actor, svg .actor text, svg .actor-box text, svg .participant text",
  );

  const cleanups: Array<() => void> = [];
  candidates.forEach((node) => {
    const text = node.textContent?.trim();
    if (!text) return;

    const location = locationByLabel.get(normalizeLabel(text));
    if (!location) return;

    cleanups.push(createClickCleanup(node, location, onOpenFile));
  });

  return cleanups;
}

function ensureSvgViewBox(svg: SVGSVGElement): void {
  if (svg.getAttribute("viewBox")) return;

  const width = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const height = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  if (width > 0 && height > 0) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
}

function applySvgScale(svg: SVGSVGElement, fitToView: boolean, zoomPercent: number): void {
  ensureSvgViewBox(svg);
  const wrapper = svg.parentElement;
  if (wrapper instanceof HTMLElement) {
    wrapper.style.width = "100%";
    wrapper.style.height = fitToView ? "100%" : "auto";
    wrapper.style.display = "flex";
    wrapper.style.justifyContent = "center";
    wrapper.style.alignItems = "flex-start";
  }

  svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
  svg.style.display = "block";
  svg.style.flex = "0 0 auto";
  svg.style.maxWidth = fitToView ? "100%" : "none";
  svg.style.maxHeight = fitToView ? "100%" : "none";
  svg.style.width = fitToView ? "100%" : `${zoomPercent}%`;
  svg.style.height = fitToView ? "100%" : "auto";
}

export function MermaidRenderer({ mermaidCode, model, onOpenFile }: Props): React.JSX.Element {
  const svgRef = React.useRef<HTMLDivElement>(null);
  const onOpenFileRef = React.useRef(onOpenFile);
  const fitToViewRef = React.useRef(true);
  const zoomPercentRef = React.useRef(100);
  const panStateRef = React.useRef<PanState | null>(null);
  const suppressNextClickRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fitToView, setFitToView] = React.useState(true);
  const [zoomPercent, setZoomPercent] = React.useState(100);
  const [isPanning, setIsPanning] = React.useState(false);

  React.useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);

  const applyCurrentScale = React.useCallback(() => {
    const svg = svgRef.current?.querySelector<SVGSVGElement>("svg");
    if (!svg) return;
    applySvgScale(svg, fitToViewRef.current, zoomPercentRef.current);
  }, []);

  React.useEffect(() => {
    fitToViewRef.current = fitToView;
    zoomPercentRef.current = zoomPercent;
    applyCurrentScale();
  }, [applyCurrentScale, fitToView, zoomPercent]);

  React.useEffect(() => {
    let cleanups: Array<() => void> = [];

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
        await mermaid.run();
        applyCurrentScale();
        cleanups = bindParticipantClicks(svgRef.current, model, (path, line) => {
          onOpenFileRef.current(path, line);
        });
      } catch (err) {
        setError(`Failed to render diagram: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    renderMermaid();

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [applyCurrentScale, mermaidCode, model]);

  const updateManualZoom = React.useCallback((nextValue: number) => {
    setFitToView(false);
    setZoomPercent(clampZoomPercent(nextValue));
  }, []);

  const zoomOut = React.useCallback(() => {
    updateManualZoom(zoomPercentRef.current - ZOOM_STEP_PERCENT);
  }, [updateManualZoom]);

  const zoomIn = React.useCallback(() => {
    updateManualZoom(zoomPercentRef.current + ZOOM_STEP_PERCENT);
  }, [updateManualZoom]);

  const resetZoom = React.useCallback(() => {
    setFitToView(false);
    setZoomPercent(100);
  }, []);

  const finishPan = React.useCallback((target: HTMLDivElement, pointerId: number) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== pointerId) return;

    suppressNextClickRef.current = panState.moved;
    panStateRef.current = null;
    setIsPanning(false);

    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (fitToViewRef.current || event.button !== 0) return;

    const target = event.target;
    if (target instanceof Element && target.closest("button, input, a")) {
      return;
    }

    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, []);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - panState.startX;
    const deltaY = event.clientY - panState.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
      panState.moved = true;
    }

    event.preventDefault();
    event.currentTarget.scrollLeft = panState.scrollLeft - deltaX;
    event.currentTarget.scrollTop = panState.scrollTop - deltaY;
  }, []);

  const handlePointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishPan(event.currentTarget, event.pointerId);
  }, [finishPan]);

  const handlePointerCancel = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishPan(event.currentTarget, event.pointerId);
  }, [finishPan]);

  const handleClickCapture = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) return;

    suppressNextClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

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

  const exportPNG = React.useCallback(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current.querySelector("svg");
    if (!svg) { alert("SVG not ready"); return; }

    const serializer = new XMLSerializer();
    const svgData = serializer.serializeToString(svg);
    const svgUrl = URL.createObjectURL(new Blob([svgData], { type: "image/svg+xml;charset=utf-8" }));
    const bbox = svg.getBoundingClientRect();
    const w = (bbox.width > 0 ? bbox.width : 800) * 2;
    const h = (bbox.height > 0 ? bbox.height : 600) * 2;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { URL.revokeObjectURL(svgUrl); return; }
    ctx.scale(2, 2);

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = "#1e1e1e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(svgUrl);
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = "sequence-diagram.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      alert("Failed to load SVG for PNG export");
    };
    img.src = svgUrl;
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={exportSVG} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export SVG
        </button>
        <button type="button" onClick={exportPNG} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export PNG
        </button>
        <button type="button" onClick={exportMermaid} style={{ padding: "6px 12px", fontSize: 12 }}>
          Export Mermaid
        </button>

        <span style={{ width: 1, height: 20, background: "var(--vscode-widget-border)" }} />

        <button
          type="button"
          onClick={() => setFitToView(true)}
          title="Fit diagram to the visible webview area"
          aria-pressed={fitToView}
          style={{
            padding: "6px 10px",
            fontSize: 12,
            borderColor: fitToView ? "var(--vscode-focusBorder)" : undefined,
          }}
        >
          Fit
        </button>
        <button
          type="button"
          onClick={zoomOut}
          title="Zoom out"
          aria-label="Zoom out"
          style={{ padding: "6px 10px", fontSize: 12, minWidth: 32 }}
        >
          -
        </button>
        <input
          type="range"
          min={MIN_ZOOM_PERCENT}
          max={MAX_ZOOM_PERCENT}
          step={ZOOM_STEP_PERCENT}
          value={zoomPercent}
          aria-label="Sequence diagram zoom"
          onChange={(event) => updateManualZoom(Number(event.target.value))}
          style={{ width: 120 }}
        />
        <button
          type="button"
          onClick={zoomIn}
          title="Zoom in"
          aria-label="Zoom in"
          style={{ padding: "6px 10px", fontSize: 12, minWidth: 32 }}
        >
          +
        </button>
        <button
          type="button"
          onClick={resetZoom}
          title="Reset zoom to 100%"
          style={{ padding: "6px 10px", fontSize: 12, minWidth: 52 }}
        >
          {zoomPercent}%
        </button>
      </div>

      {error && <div style={{ color: "var(--vscode-errorForeground)", fontSize: 12 }}>{error}</div>}

      <div
        ref={svgRef}
        onClickCapture={handleClickCapture}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerCancel}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          minHeight: 0,
          overflow: fitToView ? "hidden" : "auto",
          border: "1px solid var(--vscode-widget-border)",
          borderRadius: 6,
          padding: 8,
          flex: 1,
          display: "flex",
          justifyContent: "center",
          alignItems: "stretch",
          cursor: fitToView ? "default" : isPanning ? "grabbing" : "grab",
          userSelect: isPanning ? "none" : undefined,
        }}
      />
    </div>
  );
}
