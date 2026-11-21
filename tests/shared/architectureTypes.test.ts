import { describe, expect, it } from "vitest";
import { DIAGRAM_VIEWS } from "@/analyzer/diagram/diagramStyle";
import { DIAGRAM_TABS } from "@/shared/architecture-types";

describe("DIAGRAM_TABS (#795)", () => {
  it("names the CLI diagram views, in the same order", () => {
    // Duplicated because shared imports nothing: this test keeps the copies equal.
    expect([...DIAGRAM_TABS]).toEqual([...DIAGRAM_VIEWS]);
  });
});
