// @vitest-environment happy-dom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGRAM_TABS, type DiagramCrumb } from "@/shared/architecture-types";
import { DiagramBreadcrumb } from "@/webview/components/architecture/DiagramBreadcrumb";
import { DiagramTabs, disabledReason, focusSelectedTab, FollowToggle, UnitCapBanner } from "@/webview/components/architecture/DiagramTabs";

const all = { hasWorkspace: true, folderEntered: true, flowAvailable: true };

describe("disabledReason", () => {
  it("enables every tab with a workspace, an entered folder and a flow", () => {
    expect(DIAGRAM_TABS.map((tab) => disabledReason(tab, all))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("says why each tab is disabled", () => {
    const none = { hasWorkspace: false, folderEntered: false, flowAvailable: false };
    expect(DIAGRAM_TABS.map((tab) => disabledReason(tab, none))).toEqual([
      "Open a folder to see the Units diagram",
      "Open a folder to see the Folder diagram",
      "Open a folder to see the Matrix diagram",
      "Right-click a function in the editor and run Show Flow Diagram",
    ]);
    expect(disabledReason("folder", { ...all, folderEntered: false }))
      .toBe("Double-click a unit, or right-click a folder in the Explorer, to see its Folder diagram");
  });
});

describe("DiagramTabs", () => {
  afterEach(cleanup);

  it("names the tabs as the CLI views, selects one, keeps a disabled tab focusable with its tooltip", () => {
    const onTab = vi.fn();
    render(<DiagramTabs tab="units" state={{ ...all, flowAvailable: false }} onTab={onTab} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Units", "Folder", "Matrix", "Flow"]);
    expect(tabs.map((tab) => tab.dataset.tab)).toEqual([...DIAGRAM_TABS]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[3].getAttribute("aria-disabled")).toBe("true");
    expect((tabs[3] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(tabs[3]);
    fireEvent.click(tabs[0]);
    expect(onTab).not.toHaveBeenCalled();
    fireEvent.click(tabs[2]);
    expect(onTab).toHaveBeenCalledWith("matrix");
  });

  it("moves the focus with the arrows, wrapping around; other keys do nothing", () => {
    render(<DiagramTabs tab="matrix" state={all} onTab={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    tabs[3].focus();
    fireEvent.keyDown(tabs[3], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3], { key: "a" });
    expect(document.activeElement).toBe(tabs[3]);
    focusSelectedTab();
    expect(document.activeElement).toBe(tabs[2]);
  });
});

describe("FollowToggle and UnitCapBanner", () => {
  afterEach(cleanup);

  it("Follow cursor is a pressed toggle", () => {
    const onFollow = vi.fn();
    const { rerender } = render(<FollowToggle follow={false} onFollow={onFollow} />);
    fireEvent.click(screen.getByRole("button", { name: "Follow cursor" }));
    rerender(<FollowToggle follow onFollow={onFollow} />);
    expect(screen.getByRole("button", { name: "Follow cursor" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Follow cursor" }));
    expect(onFollow.mock.calls).toEqual([[true], [false]]);
  });

  it("the cap banner counts from the message and offers the matrix and the list", () => {
    const onMatrix = vi.fn();
    const onList = vi.fn();
    render(<UnitCapBanner unitCap={{ drawnUnits: ["a", "b"], totalUnits: 70, cap: 2 }} onMatrix={onMatrix} onList={onList} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Showing 2 of 70 units\. /);
    fireEvent.click(screen.getByRole("button", { name: "Open matrix" }));
    fireEvent.click(screen.getByRole("button", { name: "Show list" }));
    expect([onMatrix.mock.calls.length, onList.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("DiagramBreadcrumb", () => {
  afterEach(cleanup);
  const crumbs: DiagramCrumb[] = [
    { kind: "workspace", label: "ws" }, { kind: "folder", label: "src", key: "src" },
    { kind: "file", label: "a.ts", key: "src/a.ts" }, { kind: "symbol", label: "run", key: "src/a.ts:run" },
  ];

  it("lists the scope in order; every step but the current one re-scopes", () => {
    const onCrumb = vi.fn();
    render(<DiagramBreadcrumb crumbs={crumbs} onCrumb={onCrumb} />);
    const nav = screen.getByRole("navigation", { name: "Diagram scope" });
    expect(nav.textContent).toBe("ws › src › a.ts › run");
    expect(screen.getByText("run").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: "run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(onCrumb).toHaveBeenCalledWith(crumbs[2]);
  });

  it("renders nothing without a scope", () => {
    const { container } = render(<DiagramBreadcrumb crumbs={[]} onCrumb={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
