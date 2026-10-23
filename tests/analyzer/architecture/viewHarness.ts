import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import { ArchitectureViewService } from "@/extension/services/ArchitectureViewService";
import { workerState } from "@/mcp/shared/state";
import type { ArchitectureExtensionMessage, ArchitectureSummaryMessage } from "@/shared/architecture-types";
import type { CommunityMode } from "@/shared/graph-types";

/**
 * The extension's Architecture view on `rootDir`, built once through the MCP/CLI Spider of
 * `workerState`: what the golden tests compare with the CLI and MCP. Every message it posts
 * lands in `posted`.
 */
export async function buildView(rootDir: string, posted: ArchitectureExtensionMessage[] = [], communityMode: CommunityMode = "path") {
  const service = new ArchitectureViewService({
    workspaceRoot: rootDir,
    analyzeFile: (filePath) => workerState.getSpider().analyze(filePath),
    readCommunityMode: () => communityMode,
    subscribeToIndexStatus: (callback) => {
      callback({ state: "idle" } as IndexerStatusSnapshot);
      return () => {};
    },
    post: (message) => posted.push(message),
    openFile: async () => {},
    revealInFileGraph: async () => {},
    openSettings: () => {},
    warn: () => {},
  });
  await service.build();
  const summary = posted.findLast((message): message is ArchitectureSummaryMessage => message.type === "architectureSummary")!;
  return { service, summary };
}
