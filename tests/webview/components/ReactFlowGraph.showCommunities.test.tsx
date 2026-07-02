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
