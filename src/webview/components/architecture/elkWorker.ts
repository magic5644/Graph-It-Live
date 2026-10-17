import ELK, { type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerSource from "elkjs/lib/elk-worker.min.js" with { type: "text" };

/** One blob URL for the webview's lifetime: every mount starts its worker from it. */
let workerUrl: string | undefined;

export interface ElkRunner {
  layout(graph: ElkNode): Promise<ElkNode>;
  terminate(): void;
}

/**
 * ELK layouts in a Web Worker, so a large level never freezes the webview. The worker script is
 * bundled as text: a webview cannot start a worker from its resource URLs (another origin), only
 * from a blob URL (CSP `worker-src blob:`). elkjs never settles a layout when its worker fails
 * (CSP, script error), so a worker error rejects every layout instead.
 */
export function createElk(): ElkRunner {
  workerUrl ??= URL.createObjectURL(new Blob([elkWorkerSource], { type: "text/javascript" }));
  const url = workerUrl;
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // Observed through the race below; never an unhandled rejection on its own.
  failed.catch(() => undefined);
  const elk = new ELK({
    algorithms: ["layered"],
    workerFactory: () => {
      const worker = new Worker(url);
      worker.addEventListener("error", (event) => fail(new Error(`ELK worker failed: ${event.message}`)));
      return worker;
    },
  });
  return {
    layout: (graph) => Promise.race([elk.layout(graph), failed]),
    terminate: () => elk.terminateWorker(),
  };
}
