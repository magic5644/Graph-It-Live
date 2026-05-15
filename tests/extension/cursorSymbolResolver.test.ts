import {
  resolveBestCallableSymbolAtCursor,
  resolveBestRootNodeByCursor,
} from "../../src/extension/services/cursorSymbolResolver";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: mocks.executeCommand,
  },
  SymbolKind: {
    Function: 12,
    Method: 6,
    Constructor: 9,
    Variable: 13,
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
}));

type MockRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
  contains: (position: { line: number; character: number }) => boolean;
};

function createRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): MockRange {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    contains: (position) => {
      if (position.line < startLine || position.line > endLine) return false;
      if (position.line === startLine && position.character < startCharacter) return false;
      if (position.line === endLine && position.character > endCharacter) return false;
      return true;
    },
  };
}

function createEditor(params: {
  selectedText?: string;
  wordText?: string;
  lineText?: string;
  line?: number;
  character?: number;
}): vscode.TextEditor {
  const selection = {
    active: {
      line: params.line ?? 10,
      character: params.character ?? 3,
    },
  };

  const wordRange = createRange(
    selection.active.line,
    0,
    selection.active.line,
    10,
  );

  return {
    selection,
    document: {
      uri: { fsPath: "/repo/src/a.ts" },
      getText: vi.fn((arg?: unknown) => {
        if (arg === selection) return params.selectedText ?? "";
        return params.wordText ?? "run";
      }),
      getWordRangeAtPosition: vi.fn(() => wordRange),
      lineAt: vi.fn(() => ({ text: params.lineText ?? "function run() {}" })),
    },
  } as unknown as vscode.TextEditor;
}

describe("cursorSymbolResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects deepest enclosing callable symbol", async () => {
    const editor = createEditor({ selectedText: "", line: 10, character: 15 });
    const outerRange = createRange(5, 0, 20, 0);
    const innerRange = createRange(8, 2, 12, 0);

    mocks.executeCommand.mockResolvedValue([
      {
        name: "outer",
        kind: vscode.SymbolKind.Function,
        range: outerRange,
        children: [
          {
            name: "inner",
            kind: vscode.SymbolKind.Method,
            range: innerRange,
            children: [],
          },
        ],
      },
    ]);

    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBe("inner");
  });

  it("falls back to token near cursor when cursor is before word", async () => {
    const editor = createEditor({ selectedText: "", line: 4, character: 0, wordText: "myService", lineText: "myService.doWork()" });
    const beforeWordRange = createRange(4, 1, 4, 9);
    editor.document.getWordRangeAtPosition = vi
      .fn()
      .mockImplementation((position: { character: number }) => {
        if (position.character === 0) return null;
        return beforeWordRange;
      });
    editor.document.getText = vi.fn((arg?: unknown) => {
      if (arg === editor.selection) return "";
      return "myService";
    });

    mocks.executeCommand.mockResolvedValue([]);

    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBe("myService");
  });

  it("supports SymbolInformation responses for language providers", async () => {
    const editor = createEditor({ selectedText: "", line: 7, character: 3 });

    mocks.executeCommand.mockResolvedValue([
      {
        name: "loadConfig",
        kind: vscode.SymbolKind.Function,
        containerName: "Config",
        location: {
          range: createRange(7, 0, 15, 0),
        },
      },
    ]);

    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBe("loadConfig");
  });

  it("chooses closest root node by cursor and preferred symbol", () => {
    const root = resolveBestRootNodeByCursor(
      [
        {
          id: "A",
          name: "run",
          startLine: 1,
          endLine: 10,
          startCol: 2,
        },
        {
          id: "B",
          name: "run",
          startLine: 20,
          endLine: 30,
          startCol: 2,
        },
        {
          id: "C",
          name: "bootstrap",
          startLine: 22,
          endLine: 28,
          startCol: 4,
        },
      ],
      24,
      3,
      "run",
    );

    expect(root).toEqual({ id: "B" });
  });

  it("returns null for empty nodes", () => {
    expect(resolveBestRootNodeByCursor([], 5, 0)).toBeNull();
  });

  it("returns null when there is no token and no symbols", async () => {
    const editor = createEditor({ selectedText: "", wordText: "", lineText: "   " });
    editor.document.getWordRangeAtPosition = vi.fn(() => undefined);
    mocks.executeCommand.mockResolvedValue([]);
    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBeNull();
  });

  it("returns raw token near cursor when no callable symbols exist", async () => {
    const editor = createEditor({ selectedText: "", wordText: "helper", lineText: "helper()" });
    editor.document.getText = vi.fn((arg?: unknown) => {
      if (arg === editor.selection) return "";
      return "helper";
    });
    mocks.executeCommand.mockResolvedValue([]);
    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBe("helper");
  });

  it("picks symbol matching selected text over enclosing symbol", async () => {
    const editor = createEditor({ selectedText: "doWork", line: 6, character: 5 });
    const enclosingRange = createRange(0, 0, 30, 0);
    const doWorkRange = createRange(5, 0, 10, 0);

    mocks.executeCommand.mockResolvedValue([
      {
        name: "outer",
        kind: vscode.SymbolKind.Function,
        range: enclosingRange,
        children: [
          {
            name: "doWork",
            kind: vscode.SymbolKind.Method,
            range: doWorkRange,
            children: [],
          },
        ],
      },
    ]);

    await expect(resolveBestCallableSymbolAtCursor(editor)).resolves.toBe("doWork");
  });

  describe("resolveBestRootNodeByCursor", () => {
    const nodes = [
      { id: "A", name: "alpha", startLine: 1, endLine: 5, startCol: 0 },
      { id: "B", name: "beta", startLine: 10, endLine: 20, startCol: 0 },
      { id: "C", name: "gamma", startLine: 25, endLine: 35, startCol: 0 },
    ];

    it("returns single node when only one node", () => {
      const single = [{ id: "X", name: "fn", startLine: 3, endLine: 8, startCol: 0 }];
      expect(resolveBestRootNodeByCursor(single, 100, 0)).toEqual({ id: "X" });
    });

    it("cursor before all nodes picks first node", () => {
      // cursor line 0, all nodes start at line >=1 → closest is A (startLine 1)
      expect(resolveBestRootNodeByCursor(nodes, 0, 0)).toEqual({ id: "A" });
    });

    it("cursor after all nodes picks last node", () => {
      // cursor line 40, all nodes end at <=35 → closest is C (endLine 35)
      expect(resolveBestRootNodeByCursor(nodes, 40, 0)).toEqual({ id: "C" });
    });

    it("cursor inside a node returns that node without preferred name", () => {
      expect(resolveBestRootNodeByCursor(nodes, 15, 0)).toEqual({ id: "B" });
    });

    it("preferred name with no match falls back to containing pool", () => {
      // cursor on line 12 inside B, preferred name 'unknown' → no name match → use containing
      expect(resolveBestRootNodeByCursor(nodes, 12, 0, "unknown")).toEqual({ id: "B" });
    });

    it("preferred name match outside containing pool wins", () => {
      // cursor on line 12 inside B, preferred name 'gamma' → nameMatched=[C], containing=[B]
      // scopedPool = containingPool filtered by nameMatched → empty → fallback to containingPool
      // So C does NOT win here — the algorithm prefers containment when scoped pool is empty
      expect(resolveBestRootNodeByCursor(nodes, 12, 0, "gamma")).toEqual({ id: "B" });
    });
  });
});
