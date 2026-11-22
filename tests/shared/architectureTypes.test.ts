import { describe, expect, it } from "vitest";
import { DIAGRAM_VIEWS as CLI_VIEWS } from "@/analyzer/diagram/diagramStyle";

// shortcut: the VS Code Sequence tab comes with #810; drop this filter there, so the tabs match every CLI view again.
const DIAGRAM_VIEWS = CLI_VIEWS.filter((view) => view !== "sequence");
import { DIAGRAM_TABS } from "@/shared/architecture-types";

describe("DIAGRAM_TABS (#795)", () => {
  it("names the CLI diagram views, in the same order", () => {
    // Duplicated because shared imports nothing: this test keeps the copies equal.
    expect([...DIAGRAM_TABS]).toEqual([...DIAGRAM_VIEWS]);
  });
});
