import { buildArchitectureStylesheet, buildCallGraphStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";
import { describe, expect, it } from "vitest";

const styleOf = (sheet: ReturnType<typeof buildArchitectureStylesheet>, selector: string) =>
  (sheet.find(entry => "selector" in entry && entry.selector === selector) as { style: Record<string, unknown> } | undefined)?.style;

describe("CytoscapeTheme", () => {
  it("colors architecture groups and edges from the theme colors", () => {
    const sheet = buildArchitectureStylesheet({
      foreground: "#111", background: "#222", border: "#333", edge: "#444", accent: "#555",
    });

    expect(styleOf(sheet, "node")).toMatchObject({ color: "#111", "background-color": "#222", "border-color": "#555" });
    // The label wraps inside the box toArchitectureElements sized for it.
    expect(styleOf(sheet, "node")).toMatchObject({
      width: "data(width)",
      height: "data(height)",
      "text-wrap": "wrap",
      "text-max-width": "data(textWidth)",
      "text-overflow-wrap": "anywhere",
      "font-size": 11,
      "min-zoomed-font-size": 6,
    });
    expect(styleOf(sheet, "node[?unassigned]")).toEqual({ "border-style": "dashed", "border-color": "#333" });
    expect(styleOf(sheet, "edge")).toMatchObject({ "line-color": "#444", width: "data(width)", "target-arrow-shape": "triangle" });
    // Count labels only on highlighted edges.
    expect(styleOf(sheet, "edge")).not.toHaveProperty("label");
    expect(styleOf(sheet, "edge.highlighted")).toEqual({ label: "data(label)", "line-color": "#555", "target-arrow-color": "#555" });
  });

  it("builds distinct call graph palettes for dark and light themes", () => {
    const dark = styleOf(buildCallGraphStylesheet(true), "node");
    const light = styleOf(buildCallGraphStylesheet(false), "node");

    expect(dark?.color).toBe("#ffffff");
    expect(light?.color).toBe("#1a1a1a");
    expect(styleOf(buildCallGraphStylesheet(), 'node[lang="javascript"]')).toBeDefined();
  });
});
