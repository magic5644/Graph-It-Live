import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/**
 * Manages webview lifecycle, HTML generation, and security policies.
 * 
 * Extracted from GraphProvider to follow Single Responsibility Principle.
 * Responsibilities:
 * - Generate HTML content for webview
 * - Configure Content Security Policy (CSP)
 * - Generate cryptographic nonces for security
 * - Set up webview options and capabilities
 */
export class WebviewManager {
  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Configure webview options for the Graph-It-Live webview
   */
  public getWebviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
      ],
    };
  }

  /**
   * Generate HTML content for the webview
   * 
   * @param webview - The webview instance to generate HTML for
   * @returns HTML string with embedded scripts and styles
   */
  public getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const nonce = this.generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Graph-It-Live</title>
    <style>
        html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
        body { font-family: var(--vscode-font-family); }
        #root {
            height: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .control-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .control-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .react-flow__attribution { display: none; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generate a cryptographically secure nonce for CSP
   * 
   * Uses Node's crypto module for security (replaces Math.random per SonarQube S224)
   * 
   * @returns 32-character hex string
   */
  private generateNonce(): string {
    return randomBytes(16).toString("hex"); // 32 hex chars
  }
}
