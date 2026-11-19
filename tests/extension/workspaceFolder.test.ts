import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setting: "" as unknown,
  folders: undefined as Array<{ name: string; uri: { fsPath: string } }> | undefined,
  activeEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => mocks.setting ?? fallback }),
    get workspaceFolders() { return mocks.folders; },
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      mocks.folders?.find((folder) => uri.fsPath.startsWith(`${folder.uri.fsPath}/`)),
  },
  window: {
    get activeTextEditor() { return mocks.activeEditor; },
  },
}));

import { findConfiguredWorkspaceFolder, resolvePreferredWorkspaceFolder } from "../../src/extension/workspaceFolder";

const api = { name: "api", uri: { fsPath: "/repo/api" } };
const web = { name: "web", uri: { fsPath: "/repo/web" } };

describe("workspace folder resolution (#770)", () => {
  beforeEach(() => {
    mocks.setting = "";
    mocks.folders = [api, web];
    mocks.activeEditor = undefined;
  });

  it("matches the setting after normalizing separators and a trailing slash", () => {
    mocks.setting = String.raw`\repo\web\ `;
    expect(findConfiguredWorkspaceFolder()).toEqual({ configured: String.raw`\repo\web\ `.trim(), folder: web });
    expect(resolvePreferredWorkspaceFolder()).toBe(web);
  });

  it("reports a setting that matches no open folder and falls back to the first folder", () => {
    mocks.setting = "/repo/missing";
    expect(findConfiguredWorkspaceFolder()).toEqual({ configured: "/repo/missing", folder: undefined });
    expect(resolvePreferredWorkspaceFolder()).toBe(api);
  });

  it("treats an empty or non-string setting as unset", () => {
    for (const value of ["", "   ", 42, null]) {
      mocks.setting = value;
      expect(findConfiguredWorkspaceFolder().configured).toBe("");
    }
  });

  it("uses the active editor's folder when the setting is empty", () => {
    mocks.activeEditor = { document: { uri: { scheme: "file", fsPath: "/repo/web/src/a.ts" } } };
    expect(resolvePreferredWorkspaceFolder()).toBe(web);
  });

  it("ignores a non-file editor and returns undefined without folders", () => {
    mocks.activeEditor = { document: { uri: { scheme: "untitled", fsPath: "/repo/web/x" } } };
    expect(resolvePreferredWorkspaceFolder()).toBe(api);
    mocks.folders = undefined;
    expect(resolvePreferredWorkspaceFolder()).toBeUndefined();
  });
});
