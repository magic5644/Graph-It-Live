import { generateSequence } from "@/analyzer/sequence/SequenceEngine";
import { renderMermaidSequence } from "@/analyzer/sequence/renderers/mermaidSequenceRenderer";
import { resolveBestCallableSymbolAtCursor } from "@/extension/services/cursorSymbolResolver";
import type {
  SequenceGenerateCommand,
  SequenceOpenFileCommand,
  SequenceWebviewCommand,
  ShowSequenceDiagramMessage,
} from "@/shared/types";
import * as path from "node:path";
import * as vscode from "vscode";

type SequenceDefaults = {
  maxDepth: number;
  maxSteps: number;
};

const DEFAULTS: SequenceDefaults = {
  maxDepth: 6,
  maxSteps: 200,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function resolveWorkspaceRootForFile(filePath: string): string {
  const uri = vscode.Uri.file(filePath);
  const workspaceFolder =
    typeof vscode.workspace.getWorkspaceFolder === "function"
      ? vscode.workspace.getWorkspaceFolder(uri)
      : undefined;

  return workspaceFolder?.uri.fsPath ?? path.dirname(filePath);
}

export class SequenceViewService implements vscode.Disposable {
  private sidebarWebview: vscode.WebviewView | null = null;
  private readonly outputChannel: vscode.OutputChannel;
  private lastFilePath: string | null = null;
  private lastSymbolName: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Sequence Diagram");
    context.subscriptions.push(this.outputChannel);
  }

  setSidebarWebview(view: vscode.WebviewView | null): void {
    this.sidebarWebview = view;
  }

  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      await vscode.window.showInformationMessage(
        "Graph-It-Live: Open a source file before generating a sequence diagram.",
      );
      return;
    }

    const symbolName = await resolveBestCallableSymbolAtCursor(editor);
    if (!symbolName) {
      await vscode.window.showInformationMessage(
        "Graph-It-Live: Place cursor on a symbol or select a symbol name.",
      );
      return;
    }

    await this.generateAndPost({
      filePath: editor.document.uri.fsPath,
      symbolName,
      maxDepth: DEFAULTS.maxDepth,
      maxSteps: DEFAULTS.maxSteps,
    });
  }

  async handleWebviewMessage(message: SequenceWebviewCommand): Promise<void> {
    if (message.command === "sequenceOpenFile") {
      await this.openFile(message);
      return;
    }

    if (message.command === "sequenceGenerate") {
      await this.regenerate(message);
    }
  }

  dispose(): void {
    this.sidebarWebview = null;
    this.outputChannel.dispose();
  }

  private async regenerate(message: SequenceGenerateCommand): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const activeFilePath =
      editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : null;
    const selectedSymbol = editor
      ? await resolveBestCallableSymbolAtCursor(editor)
      : null;

    const filePath = message.filePath ?? this.lastFilePath ?? activeFilePath;
    const symbolName = message.symbolName ?? this.lastSymbolName ?? selectedSymbol;

    if (!filePath || !symbolName) {
      await vscode.window.showWarningMessage(
        "Graph-It-Live: Missing file or symbol for sequence generation.",
      );
      return;
    }

    await this.generateAndPost({
      filePath,
      symbolName,
      maxDepth: message.maxDepth ?? DEFAULTS.maxDepth,
      maxSteps: message.maxSteps ?? DEFAULTS.maxSteps,
    });
  }

  private async generateAndPost(params: {
    filePath: string;
    symbolName: string;
    maxDepth: number;
    maxSteps: number;
  }): Promise<void> {
    const workspaceRoot = resolveWorkspaceRootForFile(params.filePath);

    this.outputChannel.appendLine(
      `[Sequence] Generate ${params.filePath}#${params.symbolName} workspaceRoot=${workspaceRoot} depth=${params.maxDepth} steps=${params.maxSteps}`,
    );

    try {
      const model = await generateSequence({
        workspaceRoot,
        filePath: params.filePath,
        symbolName: params.symbolName,
        maxDepth: params.maxDepth,
        maxSteps: params.maxSteps,
        includeExternal: true,
        includeAnnotations: true,
        useCache: true,
      });

      this.lastFilePath = params.filePath;
      this.lastSymbolName = params.symbolName;

      const payload: ShowSequenceDiagramMessage = {
        type: "showSequenceDiagram",
        mermaid: renderMermaidSequence(model),
        model: {
          root: model.root,
          participants: model.participants,
          messages: model.messages,
          warnings: model.warnings,
          truncated: model.truncated,
          stats: model.stats,
        },
        sourceFilePath: params.filePath,
        symbolName: params.symbolName,
        maxDepth: Math.max(1, model.stats.maxDepthReached || params.maxDepth),
        maxSteps: params.maxSteps,
      };

      this.sidebarWebview?.webview
        .postMessage(payload)
        .then(undefined, (err: unknown) => {
          this.outputChannel.appendLine(
            `[Sequence] postMessage failed: ${errorMessage(err)}`,
          );
        });
    } catch (error) {
      const message = errorMessage(error);
      this.outputChannel.appendLine(`[Sequence] Error: ${message}`);
      await vscode.window.showErrorMessage(
        `Graph-It-Live sequence generation failed: ${message}`,
      );
    }
  }

  private async openFile(message: SequenceOpenFileCommand): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(message.path),
      );
      const zeroBasedLine = Math.max(0, message.line - 1);
      const pos = new vscode.Position(zeroBasedLine, 0);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        preserveFocus: false,
        preview: true,
      });
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Graph-It-Live: Could not open file: ${message.path}`,
      );
      this.outputChannel.appendLine(
        `[Sequence] openFile failed: ${errorMessage(error)}`,
      );
    }
  }
}
