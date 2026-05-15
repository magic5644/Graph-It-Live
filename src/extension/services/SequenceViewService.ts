import { generateSequence } from "@/analyzer/sequence/SequenceEngine";
import { renderMermaidSequence } from "@/analyzer/sequence/renderers/mermaidSequenceRenderer";
import type {
  SequenceGenerateCommand,
  SequenceOpenFileCommand,
  SequenceWebviewCommand,
  ShowSequenceDiagramMessage,
} from "@/shared/types";
import * as vscode from "vscode";

type SequenceDefaults = {
  maxDepth: number;
  maxSteps: number;
};

const DEFAULTS: SequenceDefaults = {
  maxDepth: 6,
  maxSteps: 200,
};

function extractSymbolFromEditor(editor: vscode.TextEditor): string | null {
  const selected = editor.document.getText(editor.selection).trim();
  if (selected.length > 0) return selected;
  return null;
}

function isCallableSymbolKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor
  );
}

async function getDocumentSymbols(
  editor: vscode.TextEditor,
): Promise<vscode.DocumentSymbol[]> {
  const documentSymbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | undefined
  >("vscode.executeDocumentSymbolProvider", editor.document.uri);

  return documentSymbols ?? [];
}

function isCursorOnSymbolLine(
  symbol: vscode.DocumentSymbol,
  cursor: vscode.Position,
): boolean {
  const startLine = symbol.range?.start?.line;
  const endLine = symbol.range?.end?.line;

  if (
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    typeof cursor?.line === "number"
  ) {
    return cursor.line >= startLine && cursor.line <= endLine;
  }

  return symbol.range?.contains?.(cursor) ?? false;
}

function hasCallableSymbolNamed(
  symbols: vscode.DocumentSymbol[],
  symbolName: string,
): boolean {
  const trimmed = symbolName.trim();
  if (trimmed.length === 0) return false;

  const visit = (symbol: vscode.DocumentSymbol): boolean => {
    if (
      isCallableSymbolKind(symbol.kind) &&
      (symbol.name === trimmed || symbol.name.endsWith(`.${trimmed}`))
    ) {
      return true;
    }

    return symbol.children.some((child) => visit(child));
  };

  return symbols.some((symbol) => visit(symbol));
}

async function getEnclosingCallableSymbol(
  editor: vscode.TextEditor,
): Promise<string | null> {
  const documentSymbols = await getDocumentSymbols(editor);
  if (documentSymbols.length === 0) return null;

  let bestName: string | null = null;
  let bestDepth = -1;
  const cursor = editor.selection.active;

  const visit = (symbol: vscode.DocumentSymbol, depth: number): void => {
    if (!isCursorOnSymbolLine(symbol, cursor)) return;

    if (isCallableSymbolKind(symbol.kind) && depth > bestDepth) {
      bestName = symbol.name;
      bestDepth = depth;
    }

    for (const child of symbol.children) {
      visit(child, depth + 1);
    }
  };

  for (const symbol of documentSymbols) {
    visit(symbol, 0);
  }

  return bestName;
}

async function extractBestSymbolFromEditor(
  editor: vscode.TextEditor,
): Promise<string | null> {
  const selected = extractSymbolFromEditor(editor);
  const documentSymbols = await getDocumentSymbols(editor);

  if (selected && hasCallableSymbolNamed(documentSymbols, selected)) {
    return selected;
  }

  const enclosingCallable = await getEnclosingCallableSymbol(editor);
  if (enclosingCallable) return enclosingCallable;

  const range = editor.document.getWordRangeAtPosition(editor.selection.active);
  if (!range) return null;
  const word = editor.document.getText(range).trim();
  return word.length > 0 ? word : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
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

    const symbolName = await extractBestSymbolFromEditor(editor);
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
      ? await extractBestSymbolFromEditor(editor)
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
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? params.filePath;

    this.outputChannel.appendLine(
      `[Sequence] Generate ${params.filePath}#${params.symbolName} depth=${params.maxDepth} steps=${params.maxSteps}`,
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
        maxDepth: params.maxDepth,
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
