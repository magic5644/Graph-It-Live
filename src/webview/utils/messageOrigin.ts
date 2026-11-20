/**
 * Whether a window `message` event may come from the VS Code extension host
 * (SonarQube S2819). The host frame shares the webview's own origin:
 * `vscode-webview://` on desktop, a `vscode-cdn.net` URL in browser-hosted VS Code.
 * An empty or "null" origin is a same-document dispatch (the sandboxed frame or a test).
 */
export function isExtensionMessageOrigin(origin: string): boolean {
  return (
    !origin ||
    origin === "null" ||
    origin === globalThis.location.origin ||
    origin.startsWith("vscode-webview://")
  );
}
