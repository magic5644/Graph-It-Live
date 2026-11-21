import * as path from "node:path";
import * as vscode from "vscode";
import { DIAGRAM_TABS, type DiagramTab } from "@/shared/architecture-types";
import { normalizePath } from "@/shared/path";
import type { GraphProvider } from "../GraphProvider";
import type { CallGraphViewService } from "./CallGraphViewService";
import type { FlowDiagramService } from "./FlowDiagramService";

/** QuickPick descriptions of the CLI's `graph-it diagram --view` names, which are the labels verbatim. */
const DESCRIPTIONS: Record<DiagramTab, string> = {
  units: "every unit and its dependencies",
  folder: "the groups of one folder",
  matrix: "dependency structure matrix of the level",
  flow: "call flow of one symbol, in call order",
};
const TAB_NAMES: Record<DiagramTab, string> = { units: "Units", folder: "Folder", matrix: "Matrix", flow: "Flow" };

/**
 * The diagrams Show Diagram… lists, in the CLI's order: Units, Folder and Matrix need a folder; Flow
 * needs a supported file (the active editor, or the Explorer file), never an Explorer folder.
 */
export function diagramChoices(context: { hasWorkspace: boolean; flowFile: boolean; fileOrFolder?: "file" | "folder" }): DiagramTab[] {
  return DIAGRAM_TABS.filter((tab) => (tab === "flow" ? context.flowFile && context.fileOrFolder !== "folder" : context.hasWorkspace));
}

export interface ShowDiagramDeps {
  provider: Pick<GraphProvider, "setViewModeArchitecture" | "getArchitectureViewService" | "getWorkspaceRoot" | "getViewMode">;
  flow: Pick<FlowDiagramService, "showAtCursor" | "showForFile" | "setFollow">;
  callGraph: Pick<CallGraphViewService, "isFlowSupported">;
}

const info = (message: string) => void vscode.window.showInformationMessage(message);

/** Show Flow Diagram (Symbol at Cursor): the mode switches only once a flow (or its empty state) is drawn. */
export async function showFlowDiagram(deps: ShowDiagramDeps, uri?: vscode.Uri): Promise<void> {
  const drawn = uri === undefined || uri.fsPath === vscode.window.activeTextEditor?.document.uri.fsPath
    ? await deps.flow.showAtCursor(vscode.window.activeTextEditor)
    : await deps.flow.showForFile(uri);
  if (drawn) await deps.provider.setViewModeArchitecture({ allowNoWorkspace: true });
}

/**
 * Units, Folder or Matrix tab: refused without a folder or outside it (mode unchanged), else waits for
 * the architecture summary under a cancellable notification. `directory`: the Folder tab's target; none asks for a unit.
 */
export async function showArchitectureDiagram(deps: ShowDiagramDeps, tab: Exclude<DiagramTab, "flow">, directory?: vscode.Uri): Promise<void> {
  const root = deps.provider.getWorkspaceRoot();
  const architecture = deps.provider.getArchitectureViewService();
  if (root === undefined || architecture === undefined) {
    info(`Graph-It-Live: Open a folder to see the ${TAB_NAMES[tab]} diagram.`);
    return;
  }
  const relative = directory === undefined ? undefined : normalizePath(path.relative(root, directory.fsPath));
  if (relative !== undefined && (relative.startsWith("..") || path.isAbsolute(relative))) {
    info(`Graph-It-Live: ${path.basename(directory!.fsPath)} is outside the workspace ${path.basename(root)}; run Graph-It-Live: Set Workspace first.`);
    return;
  }
  deps.flow.setFollow(false);
  const whenMounted = deps.provider.getViewMode() !== "architecture";
  const shown = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Graph-It-Live: drawing the ${tab} diagram…`, cancellable: true },
    (_progress, token) => {
      if (tab === "units") return architecture.showUnits({ token, whenMounted });
      if (tab === "matrix") return architecture.showMatrix({ token, whenMounted });
      return architecture.showDirectory(relative, { token, whenMounted });
    },
  );
  if (shown && whenMounted) await deps.provider.setViewModeArchitecture();
}

/** Show Diagram…: exactly the diagrams that can be drawn here, named as the CLI's views; Escape is silent. */
export async function showDiagram(deps: ShowDiagramDeps, uri?: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const flowFile = uri === undefined ? editor !== undefined && deps.callGraph.isFlowSupported(editor.document) !== null : deps.callGraph.isFlowSupported({ uri }) !== null;
  const choices = diagramChoices({ hasWorkspace: deps.provider.getWorkspaceRoot() !== undefined, flowFile, fileOrFolder: uri === undefined ? undefined : "file" });
  if (choices.length === 0) {
    info("Graph-It-Live: Open a folder or a source file to see a diagram.");
    return;
  }
  const picked = await vscode.window.showQuickPick(choices.map((view) => ({ label: view, description: DESCRIPTIONS[view], view })), {
    placeHolder: "Pick the diagram to show",
  });
  if (!picked) return;
  if (picked.view === "flow") {
    await showFlowDiagram(deps, uri);
    return;
  }
  // The Folder diagram of an Explorer file is its folder's; from the palette, a unit is asked for.
  const directory = picked.view === "folder" && uri !== undefined ? vscode.Uri.file(path.dirname(uri.fsPath)) : undefined;
  await showArchitectureDiagram(deps, picked.view, directory);
}
