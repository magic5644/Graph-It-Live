import * as vscode from 'vscode';
import { Spider } from '../../analyzer/Spider';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

export class EditorNavigationService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  parseFilePathAndSymbol(filePath: string): { actualFilePath: string; symbolName?: string } {
    const isWindowsAbsolutePath = /^[a-zA-Z]:[\\/]/.test(filePath);

    if (!isWindowsAbsolutePath && filePath.includes(':')) {
      const parts = filePath.split(':');
      return { actualFilePath: parts[0], symbolName: parts.slice(1).join(':') };
    }

    if (isWindowsAbsolutePath && filePath.lastIndexOf(':') > 1) {
      const lastColonIndex = filePath.lastIndexOf(':');
      return {
        actualFilePath: filePath.substring(0, lastColonIndex),
        symbolName: filePath.substring(lastColonIndex + 1),
      };
    }

    return { actualFilePath: filePath };
  }

  isAbsolutePath(filePath: string): boolean {
    return filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);
  }

  async openFile(filePath: string, line?: number): Promise<void> {
    const { actualFilePath, symbolName } = this.parseFilePathAndSymbol(filePath);

    if (symbolName) {
      this.logger.debug('Opening symbol', symbolName, 'in file', actualFilePath);
    } else {
      this.logger.debug('Opening file', actualFilePath);
    }

    if (!this.isAbsolutePath(actualFilePath)) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (workspaceRoot && (actualFilePath.startsWith('.') || !actualFilePath.includes('/'))) {
        vscode.window.showInformationMessage(
          `Cannot open external dependency: ${actualFilePath}. This symbol is imported from outside the current file.`
        );
        return;
      }
    }

    const doc = await vscode.workspace.openTextDocument(actualFilePath);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

    if (line && line > 0) {
      this.navigateToLine(editor, line);
    } else if (symbolName) {
      await this.navigateToSymbol(editor, actualFilePath, symbolName, filePath);
    }
  }

  async resolveDrillDownPath(requestedPath: string, currentSymbolFilePath?: string): Promise<string | undefined> {
    if (this.isAbsolutePath(requestedPath)) {
      return requestedPath;
    }

    const baseForResolve = this.getBasePath(currentSymbolFilePath);
    if (!baseForResolve) {
      vscode.window.showInformationMessage(
        `Cannot drill into dependency: ${requestedPath} - no base file to resolve from.`
      );
      return undefined;
    }

    const resolved = await this.spider.resolveModuleSpecifier(baseForResolve, requestedPath);
    if (!resolved) {
      vscode.window.showInformationMessage(
        `Cannot drill into external dependency: ${requestedPath}. This symbol is imported from outside the current file.`
      );
      return undefined;
    }
    return resolved;
  }

  private getBasePath(currentSymbolFilePath?: string): string | undefined {
    if (currentSymbolFilePath && this.isAbsolutePath(currentSymbolFilePath)) {
      return currentSymbolFilePath;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
      return editor.document.fileName;
    }
    return undefined;
  }

  private navigateToLine(editor: vscode.TextEditor, line: number): void {
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private async navigateToSymbol(
    editor: vscode.TextEditor,
    actualFilePath: string,
    symbolName: string,
    originalFilePath: string
  ): Promise<void> {
    try {
      const { symbols } = await this.spider.getSymbolGraph(actualFilePath);
      const symbol = symbols.find((s) => s.name === symbolName || s.id === originalFilePath);

      if (symbol?.line) {
        this.navigateToLine(editor, symbol.line);
      }
    } catch (symbolError) {
      this.logger.warn('Could not navigate to symbol', symbolError);
    }
  }
}
