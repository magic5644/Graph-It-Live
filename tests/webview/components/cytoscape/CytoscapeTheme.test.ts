import { buildArchitectureStylesheet, buildCallGraphStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";
import { describe, expect, it } from "vitest";

const styleOf = (sheet: ReturnType<typeof buildArchitectureStylesheet>, selector: string) =>
  (sheet.find(entry => "selector" in entry && entry.selector === selector) as { style: Record<string, unknown> } | undefined)?.style;

const colors = {
  foreground: "#111", background: "#222", border: "#333", edge: "#444", accent: "#555", error: "#666",
  findMatch: "rgb(1, 2, 3)", findMatchOpacity: 0.4, contrastBorder: "#777",
};

/** A style value as Cytoscape reads it for `data`: mappers are called with the element. */
const valueFor = (value: unknown, data: Record<string, unknown>) =>
  (typeof value === "function" ? value({ data: (key: string) => data[key] }) : value);

describe("CytoscapeTheme", () => {
  it("colors architecture groups and edges from the theme colors", () => {
    const sheet = buildArchitectureStylesheet(colors);

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
    // Upward and cycle unit edges use the error colour and always show their count.
    expect(styleOf(sheet, 'edge[kind = "upward"], edge[kind = "cycle"]')).toEqual({ label: "data(label)", "line-color": "#666", "target-arrow-color": "#666" });
    // Selected and found nodes get a focus ring in the accent colour; found ones also the find match underlay.
    expect(styleOf(sheet, "node.selected")).toEqual({ "border-width": 4, "border-style": "solid", "border-color": "#555" });
    expect(styleOf(sheet, "node.found")).toMatchObject({ "border-width": 4, "border-color": "#555", "underlay-color": "rgb(1, 2, 3)", "underlay-opacity": 0.4 });
    // A cycle block: dashed, in the error colour, without fill.
    expect(styleOf(sheet, "node[?cycle]")).toMatchObject({ "border-style": "dashed", "border-color": "#666", "background-opacity": 0, "text-valign": "top" });
  });

  it("draws a unit's hue in the theme's tone: a light fill, or a bordered outline without fill on high-contrast themes", () => {
    const dark = styleOf(buildArchitectureStylesheet(colors, "vscode-dark"), "node[hue]")!;
    expect(valueFor(dark["background-color"], { hue: 120 })).toBe("hsl(120, 60%, 45%)");
    expect(valueFor(dark["border-color"], { hue: 120 })).toBe("hsl(120, 60%, 45%)");
    expect(dark["background-opacity"]).toBe(0.25);
    expect(dark).not.toHaveProperty("outline-width");

    const contrast = styleOf(buildArchitectureStylesheet(colors, "vscode-high-contrast"), "node[hue]")!;
    expect(contrast["background-opacity"]).toBe(0);
    expect(contrast).toMatchObject({ "outline-width": 1, "outline-color": "#777" });
    expect(styleOf(buildArchitectureStylesheet(colors, "vscode-high-contrast-light"), "node[hue]")).toMatchObject({ "background-opacity": 0 });
  });

  it("builds distinct call graph palettes for dark and light themes", () => {
    const dark = styleOf(buildCallGraphStylesheet(true), "node");
    const light = styleOf(buildCallGraphStylesheet(false), "node");

    expect(dark?.color).toBe("#ffffff");
    expect(light?.color).toBe("#1a1a1a");
    expect(styleOf(buildCallGraphStylesheet(), 'node[lang="javascript"]')).toBeDefined();
  });
});
