/**
 * Whether a window `message` event may come from the VS Code extension host
 * (SonarQube S2819). Extension messages arrive from the webview's own
 * `vscode-webview://` origin; an empty or "null" origin is a same-document
 * dispatch (the sandboxed frame or a test), never another site.
 */
export function isExtensionMessageOrigin(origin: string): boolean {
  return !origin || origin === "null" || origin.startsWith("vscode-webview://");
}
