import { describe, expect, it, vi } from "vitest";
import { applyWasmTiering, LIFTOFF_FROM_NODE_MAJOR, WASM_TIERING_ENV } from "@/analyzer/languages/wasmTiering";

const LIFTOFF_FLAGS = ["--no-wasm-tier-up", "--no-wasm-dynamic-tiering"];
const NODE_24 = LIFTOFF_FROM_NODE_MAJOR;
const NODE_22 = 22;

function run(value: string | undefined, nodeMajor: number): { warning: string | undefined; flags: string[] } {
  const setFlags = vi.fn<(flag: string) => void>();
  const env: NodeJS.ProcessEnv = value === undefined ? {} : { [WASM_TIERING_ENV]: value };
  const warning = applyWasmTiering(env, setFlags, nodeMajor);
  return { warning, flags: setFlags.mock.calls.map(([flag]) => flag) };
}

describe("applyWasmTiering", () => {
  it.each([undefined, ""])("keeps WebAssembly on Liftoff from Node.js 24 when the variable is %j", (value) => {
    expect(run(value, NODE_24)).toEqual({ warning: undefined, flags: LIFTOFF_FLAGS });
    expect(run(value, NODE_24 + 1)).toEqual({ warning: undefined, flags: LIFTOFF_FLAGS });
  });

  it.each([undefined, ""])("keeps V8's default tiering before Node.js 24 when the variable is %j", (value) => {
    expect(run(value, NODE_22)).toEqual({ warning: undefined, flags: [] });
  });

  it("liftoff forces Liftoff on any Node.js", () => {
    expect(run("liftoff", NODE_22)).toEqual({ warning: undefined, flags: LIFTOFF_FLAGS });
    expect(run("liftoff", NODE_24)).toEqual({ warning: undefined, flags: LIFTOFF_FLAGS });
  });

  it("default sets no flag on any Node.js", () => {
    expect(run("default", NODE_22)).toEqual({ warning: undefined, flags: [] });
    expect(run("default", NODE_24)).toEqual({ warning: undefined, flags: [] });
  });

  it.each(["Default", "turbofan", " liftoff"])("warns on %j, names the accepted values and keeps the Node.js choice", (value) => {
    expect(run(value, NODE_24)).toEqual({
      flags: LIFTOFF_FLAGS,
      warning: `Graph-It-Live: ${WASM_TIERING_ENV}=${value} is not "liftoff" or "default"; using liftoff (the Node.js 24 choice).`,
    });
    expect(run(value, NODE_22)).toEqual({
      flags: [],
      warning: `Graph-It-Live: ${WASM_TIERING_ENV}=${value} is not "liftoff" or "default"; using V8's default tiering (the Node.js 22 choice).`,
    });
  });

  it("reads process.env and the running Node.js, and sets real V8 flags, by default", () => {
    // The real flags only show in RSS (#800 table); this checks the default arguments run without throwing.
    vi.stubEnv(WASM_TIERING_ENV, "liftoff");
    try {
      expect(applyWasmTiering()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
