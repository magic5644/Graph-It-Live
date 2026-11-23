import { setFlagsFromString } from "node:v8";

/** Environment variable that chooses how V8 compiles tree-sitter's WebAssembly in the CLI and MCP server (#800). */
export const WASM_TIERING_ENV = "GRAPH_IT_WASM_TIERING";

/** First Node.js major where Liftoff only saves memory: Node 22 used as much RSS cold with it, and ran slower (#800). */
export const LIFTOFF_FROM_NODE_MAJOR = 24;

/**
 * Keeps tree-sitter's WebAssembly on V8's baseline compiler (Liftoff), the effect of `node --liftoff-only`: on
 * Node.js 24 the optimizing tier's code for the TypeScript/TSX grammars costs 2 to 3 GB RSS once files are parsed.
 * `--liftoff-only` itself does nothing once V8 runs (its implications are applied at startup), so this sets the two
 * flags it implies. V8 flags are process-wide: call it before the first WebAssembly compile and worker threads
 * inherit it. Unset: Liftoff only from Node.js 24; `liftoff` or `default` force either choice.
 * Returns a warning line for any other value, which is then ignored.
 */
export function applyWasmTiering(
  env: NodeJS.ProcessEnv = process.env,
  setFlags: (flag: string) => void = setFlagsFromString,
  nodeMajor: number = Number(process.versions.node.split(".")[0]),
): string | undefined {
  const value = env[WASM_TIERING_ENV] || undefined;
  const known = value === undefined || value === "liftoff" || value === "default";
  const liftoff = value === "liftoff" || (value !== "default" && nodeMajor >= LIFTOFF_FROM_NODE_MAJOR);
  if (liftoff) {
    setFlags("--no-wasm-tier-up");
    setFlags("--no-wasm-dynamic-tiering");
  }
  if (known) return undefined;
  const used = liftoff ? "liftoff" : "V8's default tiering";
  return `Graph-It-Live: ${WASM_TIERING_ENV}=${value} is not "liftoff" or "default"; using ${used} (the Node.js ${nodeMajor} choice).`;
}
