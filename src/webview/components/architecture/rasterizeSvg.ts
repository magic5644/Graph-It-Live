/**
 * The PNG export of the Architecture view: the analyzer's SVG drawn on a canvas at `scale`, never
 * a screenshot of the Cytoscape canvas. Returns the base64 of the PNG, without the data URL prefix.
 */
export async function rasterizeSvg(svg: string, width: number, height: number, scale = 2): Promise<string> {
  if (!(width > 0 && height > 0 && scale > 0)) throw new Error(`the diagram has no size to draw (${width}×${height})`);
  const image = new Image();
  // A data URL: the view's CSP allows data: images, and the SVG holds no external reference.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  // Chromium's canvas limits: past them the allocation fails or stalls the view.
  if (canvas.width > MAX_CANVAS_SIDE || canvas.height > MAX_CANVAS_SIDE || canvas.width * canvas.height > MAX_CANVAS_AREA) throw tooLarge(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this view has no 2D canvas");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // A canvas over the browser's size limit gives "data:,": no PNG.
  const png = canvas.toDataURL("image/png").split(",")[1] ?? "";
  if (png === "") throw tooLarge(canvas);
  return png;
}

const MAX_CANVAS_SIDE = 32_767;
const MAX_CANVAS_AREA = 268_435_456;

const tooLarge = (canvas: HTMLCanvasElement) => new Error(`the diagram (${canvas.width}×${canvas.height} px) is too large for a PNG; export it as SVG`);
