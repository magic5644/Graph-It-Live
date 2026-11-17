import { afterEach, describe, expect, it } from "vitest";
import { assessWorkspace as assess, cycleWins, edgeFlags, removeWorkspaces, renderDryRun } from "./cycleHarness";

/** The fixtures of #740: init tells a runtime cycle from a type-only one. */
describe("type-only cycles (#740)", () => {
  afterEach(removeWorkspaces);

  it("reports two files importing each other only through import type as type-only, out of the hot spot", async () => {
    const { graph, assessment } = await assess({
      "a/user.ts": 'import type { Role } from "../b/role";\nexport interface User { role: Role }\n',
      "b/role.ts": 'import type { User } from "../a/user";\nexport type Role = { owner: User };\n',
    });
    expect(edgeFlags(graph)).toEqual(["a/user.ts -> b/role.ts (type)", "b/role.ts -> a/user.ts (type)"]);
    expect(cycleWins(assessment)).toEqual([]);
    expect(assessment.totals).toMatchObject({ unitCycles: 0, mutualImports: 0, typeOnlyUnitCycles: 1, typeOnlyMutualImports: 1 });
    expect(assessment.totals.mutualHotSpot).toBeUndefined();
    expect(assessment.typeOnlyCycles).toEqual({
      unitCycles: 1, mutualImports: 1, evidence: ["a/user.ts <-> b/role.ts", "units a, b"], totalEvidence: 2, units: ["a", "b"],
    });
  });

  it("reports one value import and one type import between two files as a runtime cycle", async () => {
    const { graph, assessment } = await assess({
      "a/user.ts": 'import { makeRole } from "../b/role";\nexport const user = () => makeRole();\nexport interface User { id: string }\n',
      "b/role.ts": 'import type { User } from "../a/user";\nexport const makeRole = (owner?: User) => ({ owner });\n',
    });
    expect(edgeFlags(graph)).toEqual(["a/user.ts -> b/role.ts", "b/role.ts -> a/user.ts (type)"]);
    expect(cycleWins(assessment).sort()).toEqual(["cycle-break", "mutual-import"]);
    expect(assessment.totals).toMatchObject({ unitCycles: 1, mutualImports: 1, typeOnlyUnitCycles: 0, typeOnlyMutualImports: 0 });
  });

  it("keeps a file type-only only when every import of it is type-only", async () => {
    const { graph } = await assess({
      "a/user.ts": 'import type { Role } from "../b/role";\nimport { makeRole } from "../b/role";\nexport const user = makeRole;\nexport type U = Role;\n',
      "b/role.ts": "export type Role = string;\nexport const makeRole = () => 'r';\n",
    });
    expect(edgeFlags(graph)).toEqual(["a/user.ts -> b/role.ts"]);
  });

  it("tells a barrel re-exporting a value (runtime) from one re-exporting only types (type-only)", async () => {
    const value = await assess({
      "lib/index.ts": 'export { helper } from "./helper";\nexport interface Options { deep: boolean }\n',
      "lib/helper.ts": 'import type { Options } from "./index";\nexport const helper = (options: Options) => options.deep;\n',
    });
    expect(edgeFlags(value.graph)).toEqual(["lib/helper.ts -> lib/index.ts (type)", "lib/index.ts -> lib/helper.ts"]);
    expect(value.assessment.totals).toMatchObject({ mutualImports: 1, typeOnlyMutualImports: 0 });

    const types = await assess({
      "lib/index.ts": 'export type { Shape } from "./shape";\nexport interface Options { deep: boolean }\n',
      "lib/shape.ts": 'import type { Options } from "./index";\nexport interface Shape { options: Options }\n',
    });
    expect(edgeFlags(types.graph)).toEqual(["lib/index.ts -> lib/shape.ts (type)", "lib/shape.ts -> lib/index.ts (type)"]);
    expect(types.assessment.totals).toMatchObject({ mutualImports: 0, typeOnlyMutualImports: 1 });
  });

  it("shows runtime and type-only totals apart in the summary, and lists type-only cycles in one item", async () => {
    const { assessment } = await assess({
      "a/user.ts": 'import type { Role } from "../b/role";\nexport interface User { role: Role }\n',
      "b/role.ts": 'import type { User } from "../a/user";\nexport type Role = { owner: User };\n',
    });
    const text = renderDryRun(assessment);
    expect(text).toContain("Cycles: 0 runtime unit cycles, 0 runtime mutual file imports; type-only: 1 unit cycle, 1 mutual file import; lazy: 0 unit cycles, 0 mutual file imports");
    expect(text).toContain("[type-only] a, b: 1 unit cycle and 1 mutual file import whose every import is type-only: design coupling, no init-order risk.");
    expect(text).not.toMatch(/Top action: .*type-only/);
  });
});
