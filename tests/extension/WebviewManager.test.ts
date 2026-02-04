import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebviewManager } from "../../src/extension/WebviewManager";

// Mock vscode module
vi.mock("vscode", () => {
  return {
    Uri: {
      joinPath: vi.fn((...args: string[]) => ({
        fsPath: args.join("/"),
        toString: () => args.join("/"),
      })),
    },
  };
});

// Import after mocking
const vscode = await import("vscode");

describe("WebviewManager", () => {
  let webviewManager: WebviewManager;
  let mockExtensionUri: vscode.Uri;
  let mockWebview: vscode.Webview;

  beforeEach(() => {
    // Create mock extension URI
    mockExtensionUri = { fsPath: "/test/extension" } as vscode.Uri;

    // Mock Uri.joinPath
    vi.mocked(vscode.Uri.joinPath).mockReturnValue({
      fsPath: "/test/extension/dist",
    } as vscode.Uri);

    // Create mock webview with proper structure
    const mockAsWebviewUri = vi.fn((uri: vscode.Uri) => ({
      ...uri,
      toString: () => "vscode-webview://webview-uri/dist/webview.js",
    })) as unknown as (uri: vscode.Uri) => vscode.Uri;

    mockWebview = {
      asWebviewUri: mockAsWebviewUri,
      cspSource: "vscode-webview://test-csp-source",
    } as unknown as vscode.Webview;

    webviewManager = new WebviewManager(mockExtensionUri);
  });

  describe("getWebviewOptions", () => {
    it("should return webview options with scripts enabled", () => {
      const options = webviewManager.getWebviewOptions();

      expect(options.enableScripts).toBe(true);
      expect(options.localResourceRoots).toBeDefined();
      expect(Array.isArray(options.localResourceRoots)).toBe(true);
    });

    it("should include extension dist directory in local resource roots", () => {
      const options = webviewManager.getWebviewOptions();

      expect(options.localResourceRoots).toHaveLength(1);
      expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
        mockExtensionUri,
        "dist",
      );
    });
  });

  describe("getHtmlForWebview", () => {
    it("should generate valid HTML document", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("<head>");
      expect(html).toContain("<body>");
      expect(html).toContain("</html>");
    });

    it("should include Content Security Policy meta tag", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain("<meta http-equiv=\"Content-Security-Policy\"");
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("style-src");
      expect(html).toContain("script-src 'nonce-");
      expect(html).toContain("img-src");
    });

    it("should use webview CSP source in Content Security Policy", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain(mockWebview.cspSource);
    });

    it("should include script tag with nonce", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      // Extract nonce from CSP meta tag
      const nonceMatch = html.match(/nonce-([a-f0-9]{32})/);
      expect(nonceMatch).toBeTruthy();

      const nonce = nonceMatch?.[1];
      expect(nonce).toBeDefined();
      expect(nonce).toHaveLength(32);

      // Verify script tag uses same nonce
      expect(html).toContain(`<script nonce="${nonce}"`);
    });

    it("should include root div for React mounting", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain('<div id="root">');
    });

    it("should include VS Code theming CSS variables", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain("var(--vscode-font-family)");
      expect(html).toContain("var(--vscode-editor-background)");
      expect(html).toContain("var(--vscode-editor-foreground)");
      expect(html).toContain("var(--vscode-button-background)");
      expect(html).toContain("var(--vscode-button-foreground)");
      expect(html).toContain("var(--vscode-button-hoverBackground)");
    });

    it("should hide ReactFlow attribution", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain(".react-flow__attribution { display: none; }");
    });

    it("should generate unique nonces for different calls", () => {
      const html1 = webviewManager.getHtmlForWebview(mockWebview);
      const html2 = webviewManager.getHtmlForWebview(mockWebview);

      const nonce1Match = html1.match(/nonce-([a-f0-9]{32})/);
      const nonce2Match = html2.match(/nonce-([a-f0-9]{32})/);

      expect(nonce1Match).toBeTruthy();
      expect(nonce2Match).toBeTruthy();

      const nonce1 = nonce1Match?.[1];
      const nonce2 = nonce2Match?.[1];

      // Nonces should be different for security
      expect(nonce1).not.toBe(nonce2);
    });

    it("should call asWebviewUri to get script URI", () => {
      webviewManager.getHtmlForWebview(mockWebview);

      expect(mockWebview.asWebviewUri).toHaveBeenCalled();
      expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
        mockExtensionUri,
        "dist",
        "webview.js",
      );
    });

    it("should include webview script URI in script tag", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain('src="vscode-webview://webview-uri/dist/webview.js"');
    });

    it("should set proper viewport for responsive design", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    });

    it("should set document title to Graph-It-Live", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain("<title>Graph-It-Live</title>");
    });

    it("should set proper charset encoding", () => {
      const html = webviewManager.getHtmlForWebview(mockWebview);

      expect(html).toContain('<meta charset="UTF-8">');
    });
  });
});
