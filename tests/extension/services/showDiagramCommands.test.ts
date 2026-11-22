import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vs = vi.hoisted(() => ({
  editor: undefined as unknown,
  info: vi.fn(),
  quickPick: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  window: {
    get activeTextEditor() { return vs.editor; },
    showInformationMessage: vs.info,
    showQuickPick: vs.quickPick,
    withProgress: vs.withProgress,
  },
}));

import * as vscode from "vscode";
import { DIAGRAM_VIEWS } from "@/analyzer/diagram/diagramStyle";
import { diagramChoices, showArchitectureDiagram, showDiagram, showFlowDiagram, type ShowDiagramDeps } from "@/extension/services/showDiagramCommands";
import { DIAGRAM_TABS } from "@/shared/architecture-types";

const ROOT = path.resolve("/repo");
const uri = (relative: string) => vscode.Uri.file(path.join(ROOT, relative));

describe("diagramChoices", () => {
  it("lists exactly the CLI's views, in its order, when everything can be drawn", () => {
    expect(diagramChoices({ hasWorkspace: true, flowFile: true })).toEqual([...DIAGRAM_VIEWS]);
    expect([...DIAGRAM_TABS]).toEqual([...DIAGRAM_VIEWS]);
  });

  it("hides what cannot be drawn", () => {
    expect(diagramChoices({ hasWorkspace: false, flowFile: true })).toEqual(["flow", "sequence"]);
    expect(diagramChoices({ hasWorkspace: true, flowFile: false })).toEqual(["units", "folder", "matrix"]);
    expect(diagramChoices({ hasWorkspace: true, flowFile: true, fileOrFolder: "folder" })).toEqual(["units", "folder", "matrix"]);
    expect(diagramChoices({ hasWorkspace: true, flowFile: true, fileOrFolder: "file" })).toEqual(["units", "folder", "matrix", "flow", "sequence"]);
    expect(diagramChoices({ hasWorkspace: false, flowFile: false })).toEqual([]);
  });
});

describe("Show Diagram commands (#795)", () => {
  let deps: ShowDiagramDeps;
  let architecture: { showUnits: ReturnType<typeof vi.fn>; showMatrix: ReturnType<typeof vi.fn>; showDirectory: ReturnType<typeof vi.fn> };
  let workspaceRoot: string | undefined;
  let viewMode: string;
  const setViewModeArchitecture = vi.fn(async () => {});
  const flow = { showAtCursor: vi.fn(async () => true), showForFile: vi.fn(async () => true), setFollow: vi.fn() };
  const progressToken = { isCancellationRequested: false };

  beforeEach(() => {
    vi.clearAllMocks();
    vs.editor = undefined;
    workspaceRoot = ROOT;
    viewMode = "file";
    architecture = { showUnits: vi.fn(async () => true), showMatrix: vi.fn(async () => true), showDirectory: vi.fn(async () => true) };
    vs.withProgress.mockImplementation((_options, task) => task({}, progressToken));
    deps = {
      provider: {
        setViewModeArchitecture,
        getArchitectureViewService: () => (workspaceRoot === undefined ? undefined : architecture),
        getWorkspaceRoot: () => workspaceRoot,
        getViewMode: () => viewMode,
      } as never,
      flow: flow as never,
      callGraph: { isFlowSupported: (document: { uri: { fsPath: string } }) => (document.uri.fsPath.endsWith(".ts") ? "typescript" : null) } as never,
    };
  });

  it("Show Flow Diagram switches to the Architecture mode, with no folder too, only once something is drawn", async () => {
    vs.editor = { document: { uri: uri("src/a.ts") } };
    await showFlowDiagram(deps);
    expect(flow.showAtCursor).toHaveBeenCalledWith(vs.editor, { view: "flow" });
    expect(setViewModeArchitecture).toHaveBeenCalledWith({ allowNoWorkspace: true });
    // The editor menu passes the active editor's file: the cursor's symbol.
    await showFlowDiagram(deps, uri("src/a.ts"));
    expect(flow.showAtCursor).toHaveBeenCalledTimes(2);
    flow.showAtCursor.mockResolvedValueOnce(false);
    await showFlowDiagram(deps);
    expect(setViewModeArchitecture).toHaveBeenCalledTimes(2);
    await showFlowDiagram(deps, uri("src/b.ts"));
    expect(flow.showForFile).toHaveBeenCalledWith(uri("src/b.ts"), { view: "flow" });
  });

  it("refuses Units, Folder and Matrix without a folder, the mode unchanged", async () => {
    workspaceRoot = undefined;
    for (const [tab, name] of [["units", "Units"], ["folder", "Folder"], ["matrix", "Matrix"]] as const) {
      await showArchitectureDiagram(deps, tab, tab === "folder" ? uri("src") : undefined);
      expect(vs.info).toHaveBeenLastCalledWith(`Graph-It-Live: Open a folder to see the ${name} diagram.`);
    }
    expect(vs.info).toHaveBeenCalledTimes(3);
    expect(vs.withProgress).not.toHaveBeenCalled();
    expect(setViewModeArchitecture).not.toHaveBeenCalled();
  });

  it("refuses a folder outside the workspace", async () => {
    await showArchitectureDiagram(deps, "folder", vscode.Uri.file(path.resolve("/elsewhere/lib")));
    expect(vs.info).toHaveBeenCalledWith(`Graph-It-Live: lib is outside the workspace ${path.basename(ROOT)}; run Graph-It-Live: Set Workspace first.`);
    expect(architecture.showDirectory).not.toHaveBeenCalled();
  });

  it("waits under one cancellable notification, then switches the mode once the scope is posted", async () => {
    await showArchitectureDiagram(deps, "folder", uri("src/ui"));
    expect(vs.withProgress.mock.calls[0][0]).toMatchObject({ title: "Graph-It-Live: drawing the folder diagram…", cancellable: true });
    expect(architecture.showDirectory).toHaveBeenCalledWith("src/ui", { token: progressToken, whenMounted: true });
    expect(flow.setFollow).toHaveBeenCalledWith(false);
    expect(setViewModeArchitecture).toHaveBeenCalledOnce();

    viewMode = "architecture";
    await showArchitectureDiagram(deps, "units");
    expect(architecture.showUnits).toHaveBeenCalledWith({ token: progressToken, whenMounted: false });
    await showArchitectureDiagram(deps, "matrix");
    expect(architecture.showMatrix).toHaveBeenCalledOnce();
    // Already mounted: the scope went straight to the view.
    expect(setViewModeArchitecture).toHaveBeenCalledOnce();

    viewMode = "file";
    architecture.showDirectory.mockResolvedValueOnce(false);
    await showArchitectureDiagram(deps, "folder");
    expect(architecture.showDirectory).toHaveBeenLastCalledWith(undefined, expect.anything());
    expect(setViewModeArchitecture).toHaveBeenCalledOnce();
  });

  it("Show Diagram lists the drawable views by their CLI names and runs the one picked", async () => {
    vs.editor = { document: { uri: uri("src/a.ts"), languageId: "typescript" } };
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "flow"));
    await showDiagram(deps);
    expect(vs.quickPick.mock.calls[0][0].map((item: { label: string; description: string }) => item.label)).toEqual([...DIAGRAM_VIEWS]);
    expect(vs.quickPick.mock.calls[0][0][3].description).toBe("call flow of one symbol, in call order");
    expect(flow.showAtCursor).toHaveBeenCalledOnce();

    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "folder"));
    await showDiagram(deps, uri("src/ui/view.ts"));
    expect(architecture.showDirectory).toHaveBeenCalledWith("src/ui", expect.anything());

    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "matrix"));
    await showDiagram(deps, uri("README.md"));
    expect(vs.quickPick.mock.calls[2][0].map((item: { label: string }) => item.label)).toEqual(["units", "folder", "matrix"]);
    expect(architecture.showMatrix).toHaveBeenCalledOnce();

    vs.quickPick.mockResolvedValueOnce(undefined);
    await showDiagram(deps);
    expect(vs.info).not.toHaveBeenCalled();
  });

  it("Show Diagram says why nothing can be drawn", async () => {
    workspaceRoot = undefined;
    await showDiagram(deps);
    vs.editor = { document: { uri: uri("README.md"), languageId: "markdown" } };
    await showDiagram(deps);
    expect(vs.info).toHaveBeenCalledTimes(2);
    expect(vs.info).toHaveBeenCalledWith("Graph-It-Live: Open a folder or a source file to see a diagram.");
    expect(vs.quickPick).not.toHaveBeenCalled();
  });
});
