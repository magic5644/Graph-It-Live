// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { rasterizeSvg } from "@/webview/components/architecture/rasterizeSvg";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="20"><text>a & b #1</text></svg>';

/** Stands in for the browser's image decoding and 2D canvas, which happy-dom lacks. */
function fakeCanvas(options: { context?: boolean; dataUrl?: string; decode?: () => Promise<void> } = {}) {
  const drawn: { image: HTMLImageElement; args: number[]; canvas: HTMLCanvasElement }[] = [];
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(options.decode ?? (() => Promise.resolve()));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (options.context === false) return null;
    const canvas = this;
    return { drawImage: (image: HTMLImageElement, ...args: number[]) => drawn.push({ image, args, canvas }) } as never;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(options.dataUrl ?? "data:image/png;base64,UE5H");
  return drawn;
}

describe("rasterizeSvg", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws the SVG itself at 2x on a canvas and returns the PNG's base64", async () => {
    const drawn = fakeCanvas();
    await expect(rasterizeSvg(SVG, 10.5, 20)).resolves.toBe("UE5H");
    expect(drawn).toHaveLength(1);
    const { image, args, canvas } = drawn[0];
    expect(decodeURIComponent(image.src.replace("data:image/svg+xml;charset=utf-8,", ""))).toBe(SVG);
    expect([canvas.width, canvas.height]).toEqual([21, 40]);
    expect(args).toEqual([0, 0, 21, 40]);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("scales by the given factor, rounding the canvas up to whole pixels", async () => {
    const drawn = fakeCanvas();
    await rasterizeSvg(SVG, 10.5, 20, 1);
    expect([drawn[0].canvas.width, drawn[0].canvas.height]).toEqual([11, 20]);
  });

  it("fails without a 2D canvas, on a canvas too large for a PNG, and when the image does not decode", async () => {
    fakeCanvas({ context: false });
    await expect(rasterizeSvg(SVG, 10, 20)).rejects.toThrow("this view has no 2D canvas");
    vi.restoreAllMocks();
    fakeCanvas({ dataUrl: "data:," });
    await expect(rasterizeSvg(SVG, 10, 20)).rejects.toThrow("the diagram (20×40 px) is too large for a PNG; export it as SVG");
    vi.restoreAllMocks();
    fakeCanvas({ decode: () => Promise.reject(new Error("EncodingError")) });
    await expect(rasterizeSvg(SVG, 10, 20)).rejects.toThrow("EncodingError");
  });

  it("refuses a diagram without a size before drawing anything", async () => {
    const drawn = fakeCanvas();
    await expect(rasterizeSvg(SVG, 0, 20)).rejects.toThrow("the diagram has no size to draw (0×20)");
    await expect(rasterizeSvg(SVG, 10, Number.NaN)).rejects.toThrow("no size to draw");
    await expect(rasterizeSvg(SVG, 10, 20, 0)).rejects.toThrow("no size to draw");
    expect(drawn).toEqual([]);
  });

  it("refuses a canvas past Chromium's limits before drawing it", async () => {
    const drawn = fakeCanvas();
    await expect(rasterizeSvg(SVG, 20_000, 10)).rejects.toThrow("the diagram (40000×20 px) is too large for a PNG; export it as SVG");
    await expect(rasterizeSvg(SVG, 12_000, 12_000)).rejects.toThrow("(24000×24000 px) is too large");
    expect(drawn).toEqual([]);
  });
});
