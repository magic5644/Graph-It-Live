import * as vscode from 'vscode';
import { Spider } from '../../analyzer/Spider';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
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

  /**
   * Check if a path looks like a module alias (e.g., @shared/helper, @components/Button)
   */
  private isModuleAlias(filePath: string): boolean {
    return filePath.startsWith('@') || filePath.startsWith('#');
  }

  /**
   * Check if a path looks like a module notation (Python: utils.helpers, Rust: utils::helpers)
   * and convert it to an import specifier that Spider can resolve
   */
  private convertModuleNotationToImport(modulePath: string): string {
    // Python module notation: utils.helpers → utils.helpers
    // Rust module notation: utils::helpers → utils::helpers
    // Both are already in the correct format for Spider's resolveModuleSpecifier
    return modulePath;
  }

  /**
   * Resolve a non-absolute file path to an absolute path
   * @returns Resolved absolute path or undefined if resolution fails
   */
  private async resolveNonAbsolutePath(actualFilePath: string): Promise<string | undefined> {
    this.logger.debug('[NAVIGATION] Attempting to resolve non-absolute path:', actualFilePath);
    
    const importSpecifier = this.convertModuleNotationToImport(actualFilePath);
    this.logger.debug('[NAVIGATION] Import specifier:', importSpecifier);
    
    const baseFile = this.getBasePath();
    this.logger.debug('[NAVIGATION] Base file for resolution:', baseFile);
    
    if (!baseFile) {
      this.logger.debug('[NAVIGATION] No base file found to resolve path:', actualFilePath);
      vscode.window.showErrorMessage(
        `Cannot resolve path: ${actualFilePath}. No active file or workspace found.`
      );
      return undefined;
    }

    this.logger.debug('[NAVIGATION] Calling spider.resolveModuleSpecifier with:', JSON.stringify({ baseFile, importSpecifier }));
    const resolved = await this.spider.resolveModuleSpecifier(baseFile, importSpecifier);
    this.logger.debug('[NAVIGATION] Resolution result:', resolved);
    
    if (resolved) {
      this.logger.debug('[NAVIGATION] Resolved path to:', resolved);
      return resolved;
    }

    this.showResolutionError(actualFilePath);
    return undefined;
  }

  /**
   * Show appropriate error message based on the type of path that failed to resolve
   */
  private showResolutionError(actualFilePath: string): void {
    this.logger.debug('[NAVIGATION] Could not resolve path:', actualFilePath);
    
    if (this.isModuleAlias(actualFilePath)) {
      vscode.window.showErrorMessage(
        `Cannot resolve module alias: ${actualFilePath}. Make sure the alias is defined in your tsconfig.json or package.json.`
      );
    } else if (actualFilePath.startsWith('.')) {
      vscode.window.showErrorMessage(
        `Cannot resolve relative path: ${actualFilePath}. The file may not exist or is outside the workspace.`
      );
    } else if (actualFilePath.includes('.') || actualFilePath.includes('::')) {
      vscode.window.showErrorMessage(
        `Cannot resolve module: ${actualFilePath}. The module file may not exist in the workspace.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Cannot open external dependency: ${actualFilePath}. This symbol is imported from outside your project.`
      );
    }
  }

  async openFile(filePath: string, line?: number): Promise<void> {
    const { actualFilePath, symbolName } = this.parseFilePathAndSymbol(filePath);

    this.logger.debug('[NAVIGATION] openFile called with:', filePath);
    this.logger.debug('[NAVIGATION] Parsed:', JSON.stringify({ actualFilePath, symbolName }));

    if (symbolName) {
      this.logger.debug('[NAVIGATION] Opening symbol', symbolName, 'in file', actualFilePath);
    } else {
      this.logger.debug('[NAVIGATION] Opening file', actualFilePath);
    }

    let resolvedPath = actualFilePath;
    this.logger.debug('[NAVIGATION] Initial resolvedPath:', resolvedPath);
    this.logger.debug('[NAVIGATION] Is absolute path?', this.isAbsolutePath(actualFilePath));

    // If not an absolute path, try to resolve it
    if (!this.isAbsolutePath(actualFilePath)) {
      const resolved = await this.resolveNonAbsolutePath(actualFilePath);
      if (!resolved) {
        this.logger.debug('[NAVIGATION] Returning early due to resolution failure');
        return;
      }
      resolvedPath = resolved;
    }

    this.logger.debug('[NAVIGATION] About to open file with resolvedPath:', resolvedPath);

    try {
      this.logger.debug('[NAVIGATION] Attempting to open file:', resolvedPath);
      const doc = await vscode.workspace.openTextDocument(resolvedPath);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      if (line && line > 0) {
        this.navigateToLine(editor, line);
      } else if (symbolName) {
        await this.navigateToSymbol(editor, resolvedPath, symbolName, filePath);
      }
    } catch (error) {
      this.logger.error('Failed to open file:', resolvedPath, error);
      vscode.window.showErrorMessage(
        `Could not open file: ${actualFilePath}${symbolName ? ':' + symbolName : ''}. ${error instanceof Error ? error.message : String(error)}`
      );
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
