import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Spider } from '../analyzer/Spider';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/types';

export class GraphProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'graph-it-live.graphView';

    private _view?: vscode.WebviewView;
    private _spider?: Spider;
    private readonly _extensionUri: vscode.Uri;

    private readonly _context: vscode.ExtensionContext;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._initializeSpider();
    }

    private _initializeSpider() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            const config = vscode.workspace.getConfiguration('graph-it-live');
            const excludeNodeModules = config.get<boolean>('excludeNodeModules', true);
            const maxDepth = config.get<number>('maxDepth', 50);

            this._spider = new Spider({
                rootDir: workspaceRoot,
                tsConfigPath: path.join(workspaceRoot, 'tsconfig.json'),
                excludeNodeModules,
                maxDepth,
            });
        }
    }

    public updateConfig() {
        if (this._spider) {
            const config = vscode.workspace.getConfiguration('graph-it-live');
            const excludeNodeModules = config.get<boolean>('excludeNodeModules', true);
            const maxDepth = config.get<number>('maxDepth', 50);
            this._spider.updateConfig({ excludeNodeModules, maxDepth });
            this.updateGraph();
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
            console.log('GraphProvider: Received message', message);
            switch (message.command) {
                case 'openFile':
                    if (message.path) {
                        try {
                            console.log('GraphProvider: Opening file', message.path);
                            const doc = await vscode.workspace.openTextDocument(message.path);
                            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                        } catch (e) {
                            console.error('GraphProvider: Error opening file', e);
                            vscode.window.showErrorMessage(`Could not open file: ${message.path}`);
                        }
                    }
                    break;
                case 'expandNode':
                    // Handle on-demand node expansion
                    if (message.nodeId && this._spider) {
                        try {
                            console.log(`GraphProvider: Expanding node ${message.nodeId}`);
                            const knownNodesSet = new Set(message.knownNodes || []);
                            const newGraphData = await this._spider.crawlFrom(
                                message.nodeId,
                                knownNodesSet,
                                10 // extraDepth
                            );
                            
                            const expandedMessage: ExtensionToWebviewMessage = {
                                command: 'expandedGraph',
                                nodeId: message.nodeId,
                                data: newGraphData,
                            };
                            this._view?.webview.postMessage(expandedMessage);
                        } catch (e) {
                            console.error('GraphProvider: Error expanding node', e);
                        }
                    }
                    break;
                    break;
                case 'setExpandAll':
                    console.log(`GraphProvider: Setting expandAll to ${message.expandAll}`);
                    this._context.globalState.update('expandAll', message.expandAll);
                    break;
                case 'refreshGraph':
                    console.log('GraphProvider: Refreshing graph');
                    this.updateGraph();
                    break;
                case 'findReferencingFiles':
                    if (message.nodeId && this._spider) {
                        try {
                            console.log(`GraphProvider: Finding referencing files for ${message.nodeId}`);
                            const referencingFiles = await this._spider.findReferencingFiles(message.nodeId);
                            
                            // Convert dependencies to graph data
                            const nodes = referencingFiles.map(d => d.path);
                            const edges = referencingFiles.map(d => ({
                                source: d.path,
                                target: message.nodeId
                            }));
                            
                            const response: ExtensionToWebviewMessage = {
                                command: 'referencingFiles',
                                nodeId: message.nodeId,
                                data: { nodes, edges }
                            };
                            this._view?.webview.postMessage(response);
                        } catch (e) {
                            console.error('GraphProvider: Error finding referencing files', e);
                        }
                    }
                    break;
            }
        });

        // Initial update if we have an active editor
        this.updateGraph();
    }

    public async updateGraph() {
        if (!this._view || !this._spider) {
            console.log('GraphProvider: View or Spider not initialized');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme !== 'file') {
            console.log('GraphProvider: No active file editor');
            return;
        }

        const filePath = editor.document.fileName;
        console.log(`GraphProvider: Analyzing ${filePath}`);

        // Only analyze supported files
        if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(filePath)) {
            console.log('GraphProvider: Unsupported file type');
            return;
        }

        try {
            const graphData = await this._spider.crawl(filePath);
            console.log(`GraphProvider: Found ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`);
            const expandAll = this._context.globalState.get<boolean>('expandAll', false);
            const message: ExtensionToWebviewMessage = {
                command: 'updateGraph',
                filePath,
                data: graphData,
                expandAll,
            };
            this._view.webview.postMessage(message);
        } catch (error) {
            console.error('GraphProvider: Failed to analyze file:', error);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const nonce = getNonce();

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
}

function getNonce() {
    // Use cryptographically secure random bytes instead of Math.random (S224)
    return randomBytes(16).toString('hex'); // 32 hex chars
}
