// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isExtensionMessageOrigin } from "@/webview/utils/messageOrigin";

describe("isExtensionMessageOrigin", () => {
  it.each(["vscode-webview://abc123", "", "null"])("accepts %j", (origin) => {
    expect(isExtensionMessageOrigin(origin)).toBe(true);
  });

  it("accepts the webview's own origin (browser-hosted VS Code)", () => {
    expect(isExtensionMessageOrigin(globalThis.location.origin)).toBe(true);
  });

  it.each(["https://evil.example", "vscode-file://vscode-app", "https://vscode-webview://x"])(
    "rejects %j",
    (origin) => {
      expect(origin).not.toBe(globalThis.location.origin);
      expect(isExtensionMessageOrigin(origin)).toBe(false);
    },
  );
});
