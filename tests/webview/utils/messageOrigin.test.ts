import { describe, expect, it } from "vitest";
import { isExtensionMessageOrigin } from "@/webview/utils/messageOrigin";

describe("isExtensionMessageOrigin", () => {
  it.each(["vscode-webview://abc123", "", "null"])("accepts %j", (origin) => {
    expect(isExtensionMessageOrigin(origin)).toBe(true);
  });

  it.each(["https://evil.example", "http://localhost:3000", "vscode-file://vscode-app", "https://vscode-webview://x"])(
    "rejects %j",
    (origin) => {
      expect(isExtensionMessageOrigin(origin)).toBe(false);
    },
  );
});
