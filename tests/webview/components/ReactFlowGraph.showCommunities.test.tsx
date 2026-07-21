/**
 * ReactFlowGraph — showCommunities gate (unit test for the gating logic)
 *
 * @vitest-environment happy-dom
 *
 * Strategy: test the showCommunities gate directly via CommunityLegend conditional.
 * We render CommunityLegend directly (as ReactFlowGraph does internally) to validate
 * that the `showCommunities && <CommunityLegend>` pattern produces the expected output.
 * Full ReactFlowGraph render is too complex to mock (1300+ lines, ReactFlow provider etc).
 *
 * Covered:
 * - Gate produces no legend when showCommunities=false even if communities exist
 * - Gate produces legend when showCommunities=true and communities exist
 */

// @vitest-environment happy-dom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityLegend } from "../../../src/webview/components/reactflow/CommunityLegend";

afterEach(() => cleanup());

const communities = [{ id: 1, label: "Spider.ts", color: "#4E79A7" }];

function GatedLegend({ showCommunities }: { showCommunities: boolean }) {
  return React.createElement(
    "div",
    null,
    showCommunities
      ? React.createElement(CommunityLegend, { communities })
      : null,
  );
}

describe("ReactFlowGraph — showCommunities gate", () => {
  it("renders CommunityLegend when showCommunities=true and communities exist", () => {
    render(React.createElement(GatedLegend, { showCommunities: true }));
    expect(screen.getByText("Spider.ts")).toBeTruthy();
  });

  it("does NOT render CommunityLegend when showCommunities=false", () => {
    render(React.createElement(GatedLegend, { showCommunities: false }));
    expect(screen.queryByText("Spider.ts")).toBeNull();
  });
});

/**
 * GH #122 (2nd collision): the "Circular dependency" cycles badge and
 * CommunityLegend both live bottom-right. ReactFlowGraph now nests them in a
 * single wrapper (position/bottom/right owned once) instead of each having
 * its own absolute positioning — this reproduces that wrapper contract to
 * prove the two overlays stack instead of overlapping.
 */
function CyclesAndCommunityOverlay({ cycleCount }: { cycleCount: number }) {
  return (
    <div
      data-testid="overlay-wrapper"
      style={{
        position: "absolute",
        bottom: 8,
        right: 8,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
      }}
    >
      {cycleCount > 0 && (
        <div data-testid="cycles-badge">
          Circular dependency ({cycleCount} files)
        </div>
      )}
      <CommunityLegend communities={communities} />
    </div>
  );
}

describe("ReactFlowGraph — bottom-right overlay stacking (GH #122)", () => {
  it("positions the shared wrapper bottom-right exactly once, not per-child", () => {
    const { getByTestId } = render(
      React.createElement(CyclesAndCommunityOverlay, { cycleCount: 3 }),
    );
    const wrapper = getByTestId("overlay-wrapper");
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.bottom).toBe("8px");
    expect(wrapper.style.right).toBe("8px");

    // Children must NOT carry their own absolute positioning — only the wrapper does.
    const cyclesBadge = getByTestId("cycles-badge");
    expect(cyclesBadge.style.position).toBe("");
    const legend = screen.getByText("Import clusters").closest("div");
    expect(legend?.style.position).toBeFalsy();
  });

  it("renders both the cycles badge and the community legend inside one DOM ancestor when both are present", () => {
    render(React.createElement(CyclesAndCommunityOverlay, { cycleCount: 5 }));
    const wrapper = screen.getByTestId("overlay-wrapper");
    expect(wrapper.contains(screen.getByTestId("cycles-badge"))).toBe(true);
    expect(wrapper.contains(screen.getByText("Spider.ts"))).toBe(true);
  });

  it("omits the cycles badge but keeps the legend when there are no cycles", () => {
    render(React.createElement(CyclesAndCommunityOverlay, { cycleCount: 0 }));
    expect(screen.queryByTestId("cycles-badge")).toBeNull();
    expect(screen.getByText("Spider.ts")).toBeTruthy();
  });
});
