import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("elkjs/lib/elk-worker.min.js", () => ({ default: "/* elk worker */" }));

/** A Web Worker that records what elk-api posts and answers or fails when the test says so. */
class FakeWorker extends EventTarget {
  static readonly started: FakeWorker[] = [];
  readonly posted: { id: number; cmd: string }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  terminated = false;
  constructor(readonly url: string) {
    super();
    FakeWorker.started.push(this);
  }
  postMessage(message: { id: number; cmd: string }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  answer(cmd: string, data: unknown) {
    const id = this.posted.find((message) => message.cmd === cmd)?.id;
    this.onmessage?.({ data: { id, data } });
  }
  fail(message: string) {
    this.dispatchEvent(Object.assign(new Event("error"), { message }));
  }
}
vi.stubGlobal("Worker", FakeWorker);
const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:elk");

const { createElk } = await import("@/webview/components/architecture/elkWorker");

afterAll(() => {
  vi.unstubAllGlobals();
  createObjectURL.mockRestore();
});

describe("createElk", () => {
  it("lays out in a worker started from one blob URL of the bundled script, shared by every mount", async () => {
    const elk = createElk();
    createElk();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    const worker = FakeWorker.started[0];
    expect(worker.url).toBe("blob:elk");
    expect(FakeWorker.started[1].url).toBe("blob:elk");
    expect(worker.posted[0]).toMatchObject({ cmd: "register", algorithms: ["layered"] });

    const layout = elk.layout({ id: "root" });
    worker.answer("layout", { id: "root", x: 0, y: 0 });
    await expect(layout).resolves.toEqual({ id: "root", x: 0, y: 0 });
  });

  it("rejects a pending layout when the worker fails, instead of never settling", async () => {
    const elk = createElk();
    const worker = FakeWorker.started.at(-1)!;
    const layout = elk.layout({ id: "root" });
    worker.fail("Refused to create a worker (CSP)");
    await expect(layout).rejects.toThrow("ELK worker failed: Refused to create a worker (CSP)");
  });

  it("terminates its worker", () => {
    const elk = createElk();
    elk.terminate();
    expect(FakeWorker.started.at(-1)?.terminated).toBe(true);
  });
});
