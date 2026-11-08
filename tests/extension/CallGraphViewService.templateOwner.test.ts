/** Saving an external Vue `<template src>` refreshes the displayed `.vue` that reads it (#646). */
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: { workspaceFolders: undefined },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

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
});
