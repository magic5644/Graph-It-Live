import * as vscode from "vscode";
import { normalizePathForComparison } from "../shared/path";

/** Folder named by `graph-it-live.workspaceFolder`; `configured` is "" when the setting is empty. */
export function findConfiguredWorkspaceFolder(): { configured: string; folder: vscode.WorkspaceFolder | undefined } {
  // settings.json is hand-edited: a non-string value counts as unset.
  const value = vscode.workspace.getConfiguration("graph-it-live").get<unknown>("workspaceFolder", "");
  const configured = typeof value === "string" ? value.trim() : "";
  if (!configured) return { configured, folder: undefined };
  const wanted = normalizePathForComparison(configured);
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => normalizePathForComparison(candidate.uri.fsPath) === wanted,
  );
  return { configured, folder };
}

/** Folder the graph, call graph, MCP server and LM tools analyze: setting, then active editor's folder, then first. */
export function resolvePreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const { folder } = findConfiguredWorkspaceFolder();
  if (folder) return folder;

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.uri.scheme === "file") {
    const editorFolder = vscode.workspace.getWorkspaceFolder?.(activeEditor.document.uri);
    if (editorFolder) return editorFolder;
  }

  return vscode.workspace.workspaceFolders?.[0];
}
