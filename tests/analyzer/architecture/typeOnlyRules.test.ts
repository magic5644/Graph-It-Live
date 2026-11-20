import { afterEach, describe, expect, it } from "vitest";
import { checkArchitecture, parseArchitectureConfig, unitCyclePairs, type ArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import { compareArchitecture, renderArchitectureMarkdown } from "@/analyzer/architecture/architectureReview";
import { assignUnits } from "@/analyzer/architecture/architectureUnits";
import { assessWorkspace, removeWorkspaces } from "./cycleHarness";

/** a <-> b through `import type` only; c <-> d through one value import. */
const FILES = {
  "a/user.ts": 'import type { Role } from "../b/role";\nexport interface User { role: Role }\n',
  "b/role.ts": 'import type { User } from "../a/user";\nexport type Role = { owner: User };\n',
  "c/order.ts": 'import { line } from "../d/line";\nexport const order = () => line();\nexport interface Order { id: string }\n',
  "d/line.ts": 'import type { Order } from "../c/order";\nexport const line = (order?: Order) => ({ order });\n',
};

const rule = (noCycles: unknown): ArchitectureConfig => parseArchitectureConfig(JSON.stringify({ rules: [{ name: "no-cycles", noCycles }] }));

async function check(noCycles: unknown) {
  const { root, graph } = await assessWorkspace(FILES);
  const assignment = assignUnits(root, graph.nodes.map((node) => node.relativePath));
  return { result: checkArchitecture(graph, assignment, rule(noCycles)), graph, assignment };
}

const lines = (result: Awaited<ReturnType<typeof check>>["result"]) =>
  result.violations.map(({ source, target, severity, cycle }) => `${source} -> ${target} ${severity} ${cycle}`);

describe("noCycles and type-only cycles (#745)", () => {
  afterEach(removeWorkspaces);

  it("reports every cycle by default, each violation saying runtime or type-only", async () => {
    const { result } = await check("units");
    expect(lines(result)).toEqual([
      "a/user.ts -> b/role.ts error type-only",
      "b/role.ts -> a/user.ts error type-only",
      "c/order.ts -> d/line.ts error runtime",
      "d/line.ts -> c/order.ts error runtime",
    ]);
    expect(result.passed).toBe(false);
  });

  it("ignores type-only cycles with typeOnly: ignore, and keeps runtime ones", async () => {
    const { result } = await check({ between: "units", typeOnly: "ignore" });
    expect(lines(result)).toEqual(["c/order.ts -> d/line.ts error runtime", "d/line.ts -> c/order.ts error runtime"]);
    expect(result.rules[0]).toMatchObject({ violations: 2 });
  });

  it("reports type-only cycles as warnings with typeOnly: warning", async () => {
    const { result } = await check({ between: "units", typeOnly: "warning" });
    expect(lines(result)).toEqual([
      "a/user.ts -> b/role.ts warning type-only",
      "b/role.ts -> a/user.ts warning type-only",
      "c/order.ts -> d/line.ts error runtime",
      "d/line.ts -> c/order.ts error runtime",
    ]);
    expect(result.totals).toMatchObject({ errors: 2, warnings: 2 });
  });

  it("passes when the only cycle is type-only and ignored", async () => {
    const { root, graph } = await assessWorkspace({ "a/user.ts": FILES["a/user.ts"], "b/role.ts": FILES["b/role.ts"] });
    const result = checkArchitecture(graph, assignUnits(root, graph.nodes.map((node) => node.relativePath)), rule({ between: "units", typeOnly: "ignore" }));
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("applies the object form to an each element too", async () => {
    const { root, graph } = await assessWorkspace(FILES);
    const config = parseArchitectureConfig(JSON.stringify({
      elements: { top: { path: "*", each: true } },
      rules: [{ name: "no-cycles", noCycles: { between: "top", typeOnly: "ignore" } }],
    }));
    const result = checkArchitecture(graph, assignUnits(root, graph.nodes.map((node) => node.relativePath)), config);
    expect(result.violations.map(({ from, to, cycle }) => `${from} -> ${to} ${cycle}`)).toEqual(["top (c) -> top (d) runtime", "top (d) -> top (c) runtime"]);
  });

  it("refuses an unknown typeOnly mode, an unknown element and an element without each", () => {
    expect(() => rule({ between: "units", typeOnly: "error" })).toThrow(/noCycles/);
    expect(() => rule({ between: "units" })).toThrow(/noCycles/);
    expect(() => parseArchitectureConfig(JSON.stringify({ rules: [{ name: "r", noCycles: { between: "web", typeOnly: "ignore" } }] }))).toThrow(/noCycles\.between.*unknown element "web"/s);
    expect(() => parseArchitectureConfig(JSON.stringify({
      elements: { web: { path: "web/" } },
      rules: [{ name: "r", noCycles: { between: "web", typeOnly: "ignore" } }],
    }))).toThrow(/needs each: true/);
  });

  it("review_pr: unit cycles carry their kind, and the markdown names the type-only ones", async () => {
    const { graph, assignment } = await check("units");
    const pairs = unitCyclePairs(graph, assignment);
    expect(pairs.map(({ cycle }) => cycle)).toEqual(["type-only", "type-only", "runtime", "runtime"]);
    const review = compareArchitecture({}, { check: { violations: [], rules: [], unitCycles: pairs } }, false);
    expect(review.unitCycles.newViolations.map(({ cycle }) => cycle)).toEqual(["type-only", "type-only", "runtime", "runtime"]);
    const markdown = renderArchitectureMarkdown(review, (value) => value).join("\n");
    expect(markdown).toContain("- cycle between detected projects a, b: a/user.ts:1 -> b/role.ts (type-only cycle)");
    expect(markdown).toContain("- cycle between detected projects c, d: c/order.ts:1 -> d/line.ts\n");
    expect(markdown).toContain("#### New cycles between detected projects");
    expect(markdown).toContain("Detected-project cycles: 4 new, 0 resolved, 0 unchanged.");
  });
});
