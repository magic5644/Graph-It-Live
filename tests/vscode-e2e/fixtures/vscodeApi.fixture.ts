declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/** The fixture's own channel to the test: a webview acquires the API once. */
export const vscode = acquireVsCodeApi();
