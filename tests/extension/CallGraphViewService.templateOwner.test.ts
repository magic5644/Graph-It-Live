/** Saving an external Vue `<template src>` refreshes the displayed `.vue` that reads it (#646). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }), workspaceFolders: undefined },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";
import { normalizePath } from "@/shared/path";

type Internals = {
  currentNeighbourhoodPaths: Set<string>;
  scheduleRefresh(filePath: string, languageId: string, workspaceRoot: string): void;
  refreshTemplateOwner(templatePath: string, workspaceRoot: string): void;
  activeOperations?: Set<Promise<unknown>>;
};

function service(findImporters: (file: string) => Promise<string[]>, shown: string[]) {
  const instance = new CallGraphViewService({ subscriptions: [], extensionPath: "/ext" } as never, findImporters);
  const internals = instance as unknown as Internals;
  internals.currentNeighbourhoodPaths = new Set(shown);
  const schedule = vi.spyOn(internals, "scheduleRefresh").mockImplementation(() => undefined);
  return { internals, schedule };
}

describe("CallGraphViewService external template save", () => {
  it("refreshes the shown .vue importing the saved template, normalized, and nothing else", async () => {
    const { internals, schedule } = service(async () => ["C:\\w\\src\\Card.vue", "/w/src/page.ts", "/w/src/Hidden.vue"], ["c:/w/src/Card.vue"]);
    internals.refreshTemplateOwner("/w/src/card.html", "/w");
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith("c:/w/src/Card.vue", "vue", "/w"));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("refreshes nothing when no shown .vue reads it, or when the importer lookup fails", async () => {
    const hidden = service(async () => ["/w/src/Hidden.vue"], ["/w/src/Card.vue"]);
    hidden.internals.refreshTemplateOwner("/w/src/card.html", "/w");
    const failing = service(() => Promise.reject(new Error("index gone")), ["/w/src/Card.vue"]);
    failing.internals.refreshTemplateOwner("/w/src/card.html", "/w");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hidden.schedule).not.toHaveBeenCalled();
    expect(failing.schedule).not.toHaveBeenCalled();
  });

  // The dependency index learns a new .vue from its create event, which a watcher may lose or deliver late (#600).
  it("finds the shown .vue by its own <template src> when the index does not list it, and not another one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-template-"));
    try {
      const write = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); return normalizePath(path.join(dir, name)); };
      const host = write("Host.vue", '<script setup lang="ts"></script>\n<template lang="html" src="./parts/host.html"></template>\n');
      const other = write("Other.vue", '<template src="./other.html"></template>\n');
      const inline = write("Inline.vue", "<template><p>host.html</p></template>\n");
      const template = path.join(dir, "parts", "host.html");
      const late = service(async () => [], [other, inline, host]);
      late.internals.refreshTemplateOwner(template, dir);
      await vi.waitFor(() => expect(late.schedule).toHaveBeenCalledWith(host, "vue", dir));
      expect(late.schedule).toHaveBeenCalledTimes(1);

      const failing = service(() => Promise.reject(new Error("index gone")), [host]);
      failing.internals.refreshTemplateOwner(template, dir);
      await vi.waitFor(() => expect(failing.schedule).toHaveBeenCalledWith(host, "vue", dir));

      const none = service(async () => [], [other, inline]);
      none.internals.refreshTemplateOwner(template, dir);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(none.schedule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
