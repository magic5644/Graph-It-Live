/**
 * Unit colours per VS Code theme kind, and the WCAG contrast of a label over its blended fill.
 * A unit keeps its hue in every theme; the lightness and fill opacity follow the theme so the
 * label (the theme's foreground) stays readable. High-contrast themes get no fill, only borders.
 */

export type ThemeKind = "vscode-light" | "vscode-dark" | "vscode-high-contrast" | "vscode-high-contrast-light";

export const THEME_KINDS: readonly ThemeKind[] = ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"];

const TONES: Record<ThemeKind, { lightness: number; opacity: number }> = {
  "vscode-dark": { lightness: 45, opacity: 0.25 },
  "vscode-light": { lightness: 45, opacity: 0.18 },
  "vscode-high-contrast": { lightness: 60, opacity: 0 },
  "vscode-high-contrast-light": { lightness: 35, opacity: 0 },
};

/** The webview body's theme kind (VS Code sets `data-vscode-theme-kind`); dark without one. */
export function themeKindOf(body: HTMLElement): ThemeKind {
  const kind = body.dataset.vscodeThemeKind;
  if (THEME_KINDS.includes(kind as ThemeKind)) return kind as ThemeKind;
  // Older hosts only set classes; the high-contrast-light body also carries vscode-high-contrast.
  return THEME_KINDS.toReversed().find((name) => body.classList.contains(name)) ?? "vscode-dark";
}

/** Golden-angle hue: every unit gets its own. */
export const unitHue = (index: number) => Math.round((index * 137.508) % 360);

/** The unit's border colour and fill opacity in a theme kind; the fill uses the same colour. */
export function unitTone(hue: number, kind: ThemeKind): { color: string; opacity: number } {
  const { lightness, opacity } = TONES[kind];
  return { color: `hsl(${hue}, 60%, ${lightness}%)`, opacity };
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgba {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: 1 };
}

function hexToRgb(hex: string): Rgba | undefined {
  const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(digits)) return undefined;
  const byte = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or `hsl()`; undefined for anything else (a name, a var). */
export function parseColor(css: string): Rgba | undefined {
  const value = css.trim();
  if (value.startsWith("#")) return hexToRgb(value.slice(1));
  const numbers = value.match(/-?[\d.]+/g)?.map(Number) ?? [];
  if (value.startsWith("hsl") && numbers.length >= 3) return hslToRgb(numbers[0], numbers[1], numbers[2]);
  if (value.startsWith("rgb") && numbers.length >= 3) return { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers[3] ?? 1 };
  return undefined;
}

/** `top` at `opacity` over an opaque `bottom`. */
export function blend(top: Rgba, opacity: number, bottom: Rgba): Rgba {
  const mix = (over: number, under: number) => over * opacity + under * (1 - opacity);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(left: Rgba, right: Rgba): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
