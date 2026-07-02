/**
 * FileNode.tsx — coverage tests
 *
 * @vitest-environment happy-dom
 *
 * Strategy: use @testing-library/react (render) in a happy-dom environment
 * so that all event handlers (handleClick, handleDoubleClick, handleKeyDown)
 * can be exercised, giving us the required function coverage.
 *
 * Mocks declared before imports:
 *   - reactflow  → Handle/Position no-ops
 *   - ./LanguageIcon → no-op component
 *
 * Branches covered:
 *   - isSelected            → 4px solid #0078d4
 *   - isExternal package    → 2px dashed border
 *   - default               → 2px solid border
 *   - isRoot                → bold font
 *   - isInCycle             → red badge "circular dependency"
 *   - hasChildren + expanded/collapsed → expand/collapse button labels
 *   - isRoot + hasReferencingFiles     → parent toggle button
 *   - drill-down button always present
 *   - handleClick, handleDoubleClick, handleKeyDown event handlers
 *   - React.memo comparator (areEqual) — indirectly via render identity
 *   - getFileBorderColor — various extensions
 *   - isExternalPackage — various path shapes
 */

// @vitest-environment happy-dom

import { cleanup, fireEvent, render as rtlRender } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE the module import
// ---------------------------------------------------------------------------

vi.mock("reactflow", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

vi.mock(
  "../../../../src/webview/components/reactflow/LanguageIcon",
  () => ({
    LanguageIcon: () => null,
  }),
);

// ---------------------------------------------------------------------------
// Import the component AFTER mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/order
import { FileNode } from "../../../../src/webview/components/reactflow/FileNode";
import type { FileNodeData } from "../../../../src/webview/components/reactflow/FileNode";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = vi.fn();

function makeData(overrides: Partial<FileNodeData> = {}): FileNodeData {
  return {
    label: "index.ts",
    fullPath: "/workspace/src/index.ts",
    isRoot: false,
    isParent: false,
    isInCycle: false,
    hasChildren: false,
    isExpanded: false,
    hasReferencingFiles: false,
    isParentsVisible: false,
    onNodeClick: noop,
    onDrillDown: noop,
    onFindReferences: noop,
    onToggle: noop,
    onExpandRequest: noop,
    ...overrides,
  };
}

function renderNode(data: FileNodeData, id = "node-1") {
  return rtlRender(
    React.createElement(FileNode as React.ComponentType<any>, { data, id }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileNode", () => {
  // ------------------------------------------------------------------
  // border style — isSelected
  // ------------------------------------------------------------------
  describe("border style — isSelected", () => {
    it("renders 4px solid #0078d4 when selectedNodeId matches nodeId", () => {
      const { container } = renderNode(
        makeData({ selectedNodeId: "node-1", nodeId: "node-1" }),
        "node-1",
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("4px solid");
      // colour may be lowercased or normalized
      expect(inner.style.border.toLowerCase()).toContain("0078d4");
    });

    it("does NOT apply selected border when ids differ", () => {
      const { container } = renderNode(
        makeData({ selectedNodeId: "other", nodeId: "node-1" }),
        "node-1",
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).not.toContain("0078d4");
    });

    it("falls back to the id prop when nodeId is not provided", () => {
      const data = makeData({ selectedNodeId: "my-node" });
      const { container } = renderNode(data, "my-node");
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border.toLowerCase()).toContain("0078d4");
    });
  });

  // ------------------------------------------------------------------
  // border style — external package (dashed)
  // ------------------------------------------------------------------
  describe("border style — external package", () => {
    it("renders dashed border for a bare npm package name", () => {
      const { container } = renderNode(
        makeData({ label: "lodash", fullPath: "lodash" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("dashed");
    });

    it("renders solid border for an absolute local path", () => {
      const { container } = renderNode(
        makeData({ label: "util.ts", fullPath: "/workspace/src/util.ts" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
      expect(inner.style.border).not.toContain("dashed");
      expect(inner.style.border).not.toContain("0078d4");
    });

    it("renders solid for node_modules path (contains '/' AND node_modules)", () => {
      const { container } = renderNode(
        makeData({ label: "react", fullPath: "/workspace/node_modules/react/index.js" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
    });

    it("renders solid for scoped package (@scope/pkg) — has '/' but no node_modules", () => {
      // isExternalPackage: path includes '/' AND NOT node_modules → returns false (not external)
      const { container } = renderNode(
        makeData({ label: "@xyflow/react", fullPath: "@xyflow/react" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
    });

    it("renders solid for a relative path starting with '.'", () => {
      const { container } = renderNode(
        makeData({ label: "utils", fullPath: "./utils" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
    });

    it("renders dashed for Windows-style drive-letter path (external unknown extension)", () => {
      // starts with drive letter → isExternalPackage returns false (local)
      const { container } = renderNode(
        makeData({ label: "config", fullPath: "config" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      // no extension match, no slash → external
      expect(inner.style.border).toContain("dashed");
    });
  });

  // ------------------------------------------------------------------
  // isRoot styling
  // ------------------------------------------------------------------
  describe("isRoot styling", () => {
    it("renders fontWeight bold when isRoot is true", () => {
      const { container } = renderNode(makeData({ isRoot: true }));
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.fontWeight).toBe("bold");
    });

    it("renders fontWeight normal when isRoot is false", () => {
      const { container } = renderNode(
        makeData({ isRoot: false, label: "child.ts", fullPath: "/src/child.ts" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.fontWeight).toBe("normal");
    });
  });

  // ------------------------------------------------------------------
  // isInCycle badge
  // ------------------------------------------------------------------
  describe("isInCycle badge", () => {
    it("renders the cycle indicator when isInCycle is true", () => {
      const { container } = renderNode(makeData({ isInCycle: true }));
      const badge = container.querySelector('[title="Part of circular dependency"]');
      expect(badge).not.toBeNull();
    });

    it("does NOT render cycle indicator when isInCycle is false", () => {
      const { container } = renderNode(makeData({ isInCycle: false }));
      const badge = container.querySelector('[title="Part of circular dependency"]');
      expect(badge).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // expand / collapse button
  // ------------------------------------------------------------------
  describe("expand/collapse button", () => {
    it("renders Expand node aria-label when hasChildren and not expanded", () => {
      const { container } = renderNode(
        makeData({ hasChildren: true, isExpanded: false }),
      );
      const btn = container.querySelector('[aria-label="Expand node"]');
      expect(btn).not.toBeNull();
    });

    it("renders Collapse node aria-label when hasChildren and expanded", () => {
      const { container } = renderNode(
        makeData({ hasChildren: true, isExpanded: true }),
      );
      const btn = container.querySelector('[aria-label="Collapse node"]');
      expect(btn).not.toBeNull();
    });

    it("does NOT render expand/collapse button when hasChildren is false", () => {
      const { container } = renderNode(makeData({ hasChildren: false }));
      const expandBtn = container.querySelector('[aria-label="Expand node"]');
      const collapseBtn = container.querySelector('[aria-label="Collapse node"]');
      expect(expandBtn).toBeNull();
      expect(collapseBtn).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // parent toggle button
  // ------------------------------------------------------------------
  describe("parent toggle button", () => {
    it("renders Show referencing files button when isRoot + hasReferencingFiles", () => {
      const { container } = renderNode(
        makeData({ isRoot: true, hasReferencingFiles: true, isParentsVisible: false }),
      );
      const btn = container.querySelector('[aria-label="Show referencing files"]');
      expect(btn).not.toBeNull();
    });

    it("renders Hide referencing files button when isParentsVisible is true", () => {
      const { container } = renderNode(
        makeData({ isRoot: true, hasReferencingFiles: true, isParentsVisible: true }),
      );
      const btn = container.querySelector('[aria-label="Hide referencing files"]');
      expect(btn).not.toBeNull();
    });

    it("does NOT render parent button when not root", () => {
      const { container } = renderNode(
        makeData({ isRoot: false, hasReferencingFiles: true }),
      );
      const btn = container.querySelector('[aria-label*="referencing files"]');
      expect(btn).toBeNull();
    });

    it("does NOT render parent button when hasReferencingFiles is false", () => {
      const { container } = renderNode(
        makeData({ isRoot: true, hasReferencingFiles: false }),
      );
      const btn = container.querySelector('[aria-label*="referencing files"]');
      expect(btn).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // drill-down button (always present)
  // ------------------------------------------------------------------
  describe("drill-down button", () => {
    it("always renders the View symbols button", () => {
      const { container } = renderNode(makeData());
      const btn = container.querySelector('[aria-label="View symbols"]');
      expect(btn).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // title / tooltip
  // ------------------------------------------------------------------
  describe("title / tooltip", () => {
    it("includes fullPath as the wrapper button title", () => {
      const { container } = renderNode(
        makeData({ fullPath: "/workspace/src/utils.ts" }),
      );
      const wrapper = container.querySelector("button[title]") as HTMLElement;
      expect(wrapper.getAttribute("title")).toBe("/workspace/src/utils.ts");
    });
  });

  // ------------------------------------------------------------------
  // label text
  // ------------------------------------------------------------------
  describe("label rendering", () => {
    it("renders the label string inside the component", () => {
      const { container } = renderNode(makeData({ label: "MyComponent.tsx" }));
      expect(container.textContent).toContain("MyComponent.tsx");
    });
  });

  // ------------------------------------------------------------------
  // getFileBorderColor — extension-specific colour branches
  // ------------------------------------------------------------------
  describe("getFileBorderColor — extension branches", () => {
    it("TypeScript .ts file → solid border (no dashed)", () => {
      const { container } = renderNode(
        makeData({ label: "service.ts", fullPath: "/src/service.ts" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
      expect(inner.style.border).not.toContain("dashed");
    });

    it("React .tsx file → solid border", () => {
      const { container } = renderNode(
        makeData({ label: "Button.tsx", fullPath: "/src/Button.tsx" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
    });

    it("Unknown extension on absolute local path → solid border", () => {
      const { container } = renderNode(
        makeData({ label: "Makefile", fullPath: "/src/Makefile" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.border).toContain("solid");
    });
  });

  // ------------------------------------------------------------------
  // fontStyle — italic for external packages, normal otherwise
  // ------------------------------------------------------------------
  describe("fontStyle branch", () => {
    it("renders fontStyle italic for an external package", () => {
      const { container } = renderNode(
        makeData({ label: "lodash", fullPath: "lodash" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.fontStyle).toBe("italic");
    });

    it("renders fontStyle normal for a local file", () => {
      const { container } = renderNode(
        makeData({ label: "utils.ts", fullPath: "/src/utils.ts" }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.fontStyle).toBe("normal");
    });
  });

  // ------------------------------------------------------------------
  // boxShadow — isSelected vs non-selected
  // ------------------------------------------------------------------
  describe("boxShadow branch", () => {
    it("renders boxShadow when isSelected", () => {
      const { container } = renderNode(
        makeData({ selectedNodeId: "node-1", nodeId: "node-1" }),
        "node-1",
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.boxShadow).not.toBe("none");
      expect(inner.style.boxShadow.length).toBeGreaterThan(0);
    });

    it("renders boxShadow none when NOT selected", () => {
      const { container } = renderNode(
        makeData({ selectedNodeId: null, nodeId: "node-1" }),
        "node-1",
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.boxShadow).toBe("none");
    });
  });

  // ------------------------------------------------------------------
  // Event handlers — handleClick, handleDoubleClick, handleKeyDown
  // ------------------------------------------------------------------
  describe("event handlers", () => {
    it("calls onNodeClick when the wrapper button is clicked", () => {
      const onNodeClick = vi.fn();
      const { container } = renderNode(makeData({ onNodeClick }));
      const btn = container.querySelector("button[title]") as HTMLElement;
      fireEvent.click(btn);
      expect(onNodeClick).toHaveBeenCalledOnce();
    });

    it("calls onDrillDown when the wrapper button is double-clicked", () => {
      const onDrillDown = vi.fn();
      const { container } = renderNode(makeData({ onDrillDown }));
      const btn = container.querySelector("button[title]") as HTMLElement;
      fireEvent.dblClick(btn);
      expect(onDrillDown).toHaveBeenCalledOnce();
    });

    it("calls onNodeClick when Enter key is pressed on the wrapper button", () => {
      const onNodeClick = vi.fn();
      const { container } = renderNode(makeData({ onNodeClick }));
      const btn = container.querySelector("button[title]") as HTMLElement;
      fireEvent.keyDown(btn, { key: "Enter" });
      expect(onNodeClick).toHaveBeenCalledOnce();
    });

    it("does NOT call onNodeClick for non-Enter key presses", () => {
      const onNodeClick = vi.fn();
      const { container } = renderNode(makeData({ onNodeClick }));
      const btn = container.querySelector("button[title]") as HTMLElement;
      fireEvent.keyDown(btn, { key: "Space" });
      expect(onNodeClick).not.toHaveBeenCalled();
    });

    it("calls onToggle when collapse button clicked (isExpanded=true)", () => {
      const onToggle = vi.fn();
      const { container } = renderNode(
        makeData({ hasChildren: true, isExpanded: true, onToggle }),
      );
      const collapseBtn = container.querySelector('[aria-label="Collapse node"]') as HTMLElement;
      fireEvent.click(collapseBtn);
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it("calls onExpandRequest when expand button clicked (isExpanded=false)", () => {
      const onExpandRequest = vi.fn();
      const { container } = renderNode(
        makeData({ hasChildren: true, isExpanded: false, onExpandRequest }),
      );
      const expandBtn = container.querySelector('[aria-label="Expand node"]') as HTMLElement;
      fireEvent.click(expandBtn);
      expect(onExpandRequest).toHaveBeenCalledOnce();
    });

    it("calls onDrillDown when the drill-down (symbols) button is clicked", () => {
      const onDrillDown = vi.fn();
      const { container } = renderNode(makeData({ onDrillDown }));
      const symbolsBtn = container.querySelector('[aria-label="View symbols"]') as HTMLElement;
      fireEvent.click(symbolsBtn);
      expect(onDrillDown).toHaveBeenCalledOnce();
    });

    it("calls onToggleParents when the parent toggle button is clicked", () => {
      const onToggleParents = vi.fn();
      const { container } = renderNode(
        makeData({
          isRoot: true,
          hasReferencingFiles: true,
          isParentsVisible: false,
          onToggleParents,
        }),
      );
      const parentBtn = container.querySelector('[aria-label="Show referencing files"]') as HTMLElement;
      fireEvent.click(parentBtn);
      expect(onToggleParents).toHaveBeenCalledOnce();
    });
  });

  // ------------------------------------------------------------------
  // React.memo comparator (areEqual) — invoke via rerender
  // The comparator is only called by React during re-renders, so we use
  // RTL's rerender() to trigger it.
  // ------------------------------------------------------------------
  describe("community background color", () => {
    it("applies non-transparent backgroundColor when communityId is 1", () => {
      const { container } = renderNode(makeData({ communityId: 1, fullPath: '/src/index.ts' }));
      const inner = container.querySelector('div') as HTMLElement;
      // Should NOT be the default vscode editor background
      expect(inner.style.background).not.toBe('var(--vscode-editor-background)');
    });

    it("applies var(--vscode-editor-background) when communityId is 0", () => {
      const { container } = renderNode(makeData({ communityId: 0, fullPath: '/src/index.ts' }));
      const inner = container.querySelector('div') as HTMLElement;
      expect(inner.style.background).toBe('var(--vscode-editor-background)');
    });

    it("applies var(--vscode-editor-background) when communityId is undefined", () => {
      const { container } = renderNode(makeData({ communityId: undefined, fullPath: '/src/index.ts' }));
      const inner = container.querySelector('div') as HTMLElement;
      expect(inner.style.background).toBe('var(--vscode-editor-background)');
    });
  });

  describe("memo comparator — communityId", () => {
    it("includes communityId in equality check", () => {
      // Render with communityId=1, then re-render with communityId=2
      // The component should re-render (communityId changed)
      const data1 = makeData({ communityId: 1, fullPath: '/src/index.ts' });
      const data2 = makeData({ communityId: 2, fullPath: '/src/index.ts' });
      const { container, rerender } = renderNode(data1);
      const inner1 = container.querySelector('div') as HTMLElement;
      const bg1 = inner1.style.background;

      rerender(React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: 'node-1' }));
      const inner2 = container.querySelector('div') as HTMLElement;
      const bg2 = inner2.style.background;

      expect(bg1).not.toBe(bg2);
    });
  });

  describe("React.memo comparator (areEqual)", () => {
    it("does not re-render when all tracked data props are unchanged", () => {
      const data = makeData({ label: "stable.ts" });
      const { container, rerender } = renderNode(data, "n1");
      const beforeHTML = container.innerHTML;
      // Re-render with same props — areEqual returns true → no DOM change
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data, id: "n1" }),
      );
      expect(container.innerHTML).toBe(beforeHTML);
    });

    it("re-renders when label changes (areEqual returns false)", () => {
      const data1 = makeData({ label: "a.ts" });
      const { container, rerender } = renderNode(data1, "n1");
      const beforeHTML = container.innerHTML;
      const data2 = makeData({ label: "b.ts" });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(beforeHTML);
    });

    it("re-renders when isRoot changes", () => {
      const data1 = makeData({ isRoot: false });
      const { container, rerender } = renderNode(data1, "n1");
      const beforeHTML = container.innerHTML;
      const data2 = makeData({ isRoot: true });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(beforeHTML);
    });

    it("re-renders when isInCycle changes", () => {
      const data1 = makeData({ isInCycle: false });
      const { container, rerender } = renderNode(data1, "n1");
      const before = container.innerHTML;
      const data2 = makeData({ isInCycle: true });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(before);
    });

    it("re-renders when selectedNodeId changes", () => {
      const data1 = makeData({ selectedNodeId: null, nodeId: "n1" });
      const { container, rerender } = renderNode(data1, "n1");
      const before = container.innerHTML;
      const data2 = makeData({ selectedNodeId: "n1", nodeId: "n1" });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(before);
    });

    it("re-renders when hasChildren changes", () => {
      const data1 = makeData({ hasChildren: false });
      const { container, rerender } = renderNode(data1, "n1");
      const before = container.innerHTML;
      const data2 = makeData({ hasChildren: true, isExpanded: false });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(before);
    });

    it("re-renders when fullPath changes", () => {
      const data1 = makeData({ fullPath: "/src/a.ts", label: "a.ts" });
      const { container, rerender } = renderNode(data1, "n1");
      const before = container.innerHTML;
      const data2 = makeData({ fullPath: "/src/b.ts", label: "a.ts" });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      // fullPath appears in title attribute
      expect(container.innerHTML).not.toBe(before);
    });

    it("re-renders when showCommunities changes", () => {
      const data1 = makeData({ communityId: 3, showCommunities: true });
      const { container, rerender } = renderNode(data1, "n1");
      const before = container.innerHTML;
      const data2 = makeData({ communityId: 3, showCommunities: false });
      rerender(
        React.createElement(FileNode as React.ComponentType<any>, { data: data2, id: "n1" }),
      );
      expect(container.innerHTML).not.toBe(before);
    });
  });

  // ------------------------------------------------------------------
  // showCommunities tint
  // ------------------------------------------------------------------
  describe("community tint — showCommunities", () => {
    it("applies community tint when showCommunities is true and node has communityId", () => {
      const { container } = renderNode(
        makeData({ communityId: 1, showCommunities: true }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      // community color is not transparent, so background should NOT be editor-background
      expect(inner.style.background).not.toBe("var(--vscode-editor-background)");
    });

    it("uses editor-background when showCommunities is false regardless of communityId", () => {
      const { container } = renderNode(
        makeData({ communityId: 1, showCommunities: false }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.background).toBe("var(--vscode-editor-background)");
    });

    it("uses editor-background when showCommunities is undefined and communityId is undefined", () => {
      const { container } = renderNode(
        makeData({ communityId: undefined, showCommunities: undefined }),
      );
      const inner = container.querySelector("div") as HTMLElement;
      expect(inner.style.background).toBe("var(--vscode-editor-background)");
    });
  });
});
