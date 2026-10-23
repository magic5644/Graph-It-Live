// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  blend,
  contrastRatio,
  parseColor,
  THEME_KINDS,
  themeKindOf,
  unitHue,
  unitTone,
  type ThemeKind,
} from "@/webview/components/architecture/unitColors";

/** The default foreground on each theme kind's lightest (worst-case) view background. */
const THEMES: Record<ThemeKind, { foreground: string; backgrounds: string[] }> = {
  "vscode-dark": { foreground: "#cccccc", backgrounds: ["#181818", "#1e1e1e", "#252526"] },
  "vscode-light": { foreground: "#3b3b3b", backgrounds: ["#ffffff", "#f8f8f8", "#f3f3f3"] },
  "vscode-high-contrast": { foreground: "#ffffff", backgrounds: ["#000000"] },
  "vscode-high-contrast-light": { foreground: "#292929", backgrounds: ["#ffffff"] },
};

describe("unitColors", () => {
  it("keeps every unit label at 4.5:1 or more over its fill blended on the background, for 64 units in every theme kind", () => {
    for (const kind of THEME_KINDS) {
      const { foreground, backgrounds } = THEMES[kind];
      for (const background of backgrounds) {
        for (let index = 0; index < 64; index++) {
          const tone = unitTone(unitHue(index), kind);
          const fill = blend(parseColor(tone.color)!, tone.opacity, parseColor(background)!);
          const ratio = contrastRatio(parseColor(foreground)!, fill);
          expect(ratio, `${kind} on ${background}, unit ${index}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("fills nothing on high-contrast themes and keeps a unit's hue in every theme", () => {
    expect(unitTone(10, "vscode-high-contrast").opacity).toBe(0);
    expect(unitTone(10, "vscode-high-contrast-light").opacity).toBe(0);
    expect(new Set(THEME_KINDS.map((kind) => unitTone(unitHue(5), kind).color.split(",")[0]))).toEqual(new Set([`hsl(${unitHue(5)}`]));
    expect(new Set(Array.from({ length: 64 }, (_, index) => unitHue(index))).size).toBeGreaterThan(60);
  });

  it("parses hex, rgb, rgba and hsl colours, and nothing else", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#ea5c0055")).toEqual({ r: 234, g: 92, b: 0, a: 0x55 / 255 });
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#12")).toBeUndefined();
    expect(parseColor("#zzzzzz")).toBeUndefined();
    expect(parseColor("var(--x)")).toBeUndefined();
    expect(parseColor("red")).toBeUndefined();
  });

  it("blends and measures contrast as WCAG 2 does", () => {
    const white = parseColor("#ffffff")!;
    const black = parseColor("#000000")!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(blend(white, 0.5, black)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(blend(white, 0, black)).toEqual(black);
  });

  it("reads the theme kind from the body's attribute, else its classes, else dark", () => {
    const body = document.createElement("body");
    expect(themeKindOf(body)).toBe("vscode-dark");
    body.className = "vscode-high-contrast vscode-high-contrast-light";
    expect(themeKindOf(body)).toBe("vscode-high-contrast-light");
    body.className = "vscode-light";
    expect(themeKindOf(body)).toBe("vscode-light");
    body.dataset.vscodeThemeKind = "vscode-high-contrast";
    expect(themeKindOf(body)).toBe("vscode-high-contrast");
    body.dataset.vscodeThemeKind = "unknown";
    expect(themeKindOf(body)).toBe("vscode-light");
  });
});
