/** SVG markup, bundled as text by esbuild (`with { type: "text" }`). */
declare module "*.svg" {
  const markup: string;
  export default markup;
}
