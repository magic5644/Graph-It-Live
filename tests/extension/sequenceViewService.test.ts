import { beforeEach, describe, expect, it, vi } from "vitest";
import { SequenceViewService } from "../../src/extension/services/SequenceViewService";
import * as vscode from "vscode";

const mocks = vi.hoisted(() => ({
  generateSequence: vi.fn(),
  renderMermaidSequence: vi.fn(),
  postMessage: vi.fn().mockResolvedValue(undefined),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
}));

vi.mock("@/analyzer/sequence/SequenceEngine", () => ({
  generateSequence: mocks.generateSequence,
}));

vi.mock("@/analyzer/sequence/renderers/mermaidSequenceRenderer", () => ({
  renderMermaidSequence: mocks.renderMermaidSequence,
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: {
      document: {
        uri: { scheme: "file", fsPath: "/repo/src/app.ts" },
        getText: vi.fn(() => ""),
        getWordRangeAtPosition: vi.fn(() => ({ start: {}, end: {} })),
      },
      selection: { active: { line: 3, character: 99 } },
    },
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    showTextDocument: mocks.showTextDocument,
    createOutputChannel: mocks.createOutputChannel,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
    openTextDocument: mocks.openTextDocument,
  },
  commands: {
    executeCommand: mocks.executeCommand,
  },
  SymbolKind: {
    Function: 12,
    Method: 6,
    Constructor: 9,
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
}));

describe("SequenceViewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.generateSequence.mockResolvedValue({
      root: { id: "root", symbolName: "main", filePath: "/repo/src/app.ts" },
      participants: [],
      messages: [],
      warnings: [],
      truncated: false,
      stats: { participantsCount: 0, messagesCount: 0, analysisTimeMs: 1 },
    });
    mocks.renderMermaidSequence.mockReturnValue("sequenceDiagram");

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      activeEditor.document.getText = vi.fn((arg?: unknown) => {
        if (arg) return "main";
        return "";
      });
    }
  });

  it("posts showSequenceDiagram payload", async () => {
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const service = new SequenceViewService(context);

    service.setSidebarWebview({
      webview: { postMessage: mocks.postMessage },
    } as unknown as import("vscode").WebviewView);

    await service.show();

    expect(mocks.generateSequence).toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "showSequenceDiagram", mermaid: "sequenceDiagram" }),
    );
  });

  it("uses enclosing callable symbol when cursor is on local variable", async () => {
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const service = new SequenceViewService(context);

    service.setSidebarWebview({
      webview: { postMessage: mocks.postMessage },
    } as unknown as import("vscode").WebviewView);

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      activeEditor.document.getText = vi.fn(() => "");
      mocks.executeCommand.mockResolvedValue([
        {
          name: "main",
          kind: 12,
          range: { contains: () => true },
          children: [],
        },
      ]);
    }

    await service.show();

    expect(mocks.generateSequence).toHaveBeenCalledWith(
      expect.objectContaining({ symbolName: "main" }),
    );
  });

  it("uses callable when cursor is anywhere on same line", async () => {
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const service = new SequenceViewService(context);

    service.setSidebarWebview({
      webview: { postMessage: mocks.postMessage },
    } as unknown as import("vscode").WebviewView);

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      activeEditor.document.getText = vi.fn(() => "");
      activeEditor.selection.active = { line: 12, character: 500 } as unknown as import("vscode").Position;
      mocks.executeCommand.mockResolvedValue([
        {
          name: "getUser",
          kind: 6,
          range: {
            start: { line: 10 },
            end: { line: 20 },
            contains: () => false,
          },
          children: [],
        },
      ]);
    }

    await service.show();

    expect(mocks.generateSequence).toHaveBeenCalledWith(
      expect.objectContaining({ symbolName: "getUser" }),
    );
  });

  it("handles sequenceGenerate message", async () => {
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const service = new SequenceViewService(context);

    service.setSidebarWebview({
      webview: { postMessage: mocks.postMessage },
    } as unknown as import("vscode").WebviewView);

    await service.handleWebviewMessage({
      command: "sequenceGenerate",
      filePath: "/repo/src/service.ts",
      symbolName: "run",
      maxDepth: 4,
      maxSteps: 50,
    });

    expect(mocks.generateSequence).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/repo/src/service.ts", symbolName: "run", maxDepth: 4, maxSteps: 50 }),
    );
  });
});
