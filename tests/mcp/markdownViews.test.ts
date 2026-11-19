import { describe, expect, it } from "vitest";
import { MARKDOWN_VIEW_TOOLS, renderToolMarkdown } from "../../src/mcp/markdownViews";
import { toolSchemas } from "../../src/mcp/types";

describe("markdown views (#769)", () => {
  it("gives every MCP tool its own report", () => {
    const tools = [...Object.keys(toolSchemas), "get_session_stats"];
    expect(tools.filter((tool) => !MARKDOWN_VIEW_TOOLS.includes(tool))).toEqual([]);
  });

  it("renders a report for empty data without throwing, and nothing for an unknown tool", () => {
    for (const tool of MARKDOWN_VIEW_TOOLS) {
      expect(renderToolMarkdown(`graphitlive_${tool}`, {})).toMatch(/^# /);
    }
    expect(renderToolMarkdown("graphitlive_nope", {})).toBeUndefined();
    expect(renderToolMarkdown("graphitlive_analyze_dependencies", null)).toBeUndefined();
  });

  it("lists a call graph's candidates when the name is ambiguous", () => {
    const text = renderToolMarkdown("graphitlive_query_call_graph", {
      symbol: null,
      reason: "ambiguous",
      candidates: [{ id: "a.ts:f:1", name: "f", type: "function", startLine: 1, endLine: 2 }],
    });
    expect(text).toContain("# Call graph: ambiguous");
    expect(text).toContain("| a.ts:f:1 | f | function | 1 | 2 |");
  });

  it("flattens dead-code entries into one row per unused export, and says when graph_context found nothing", () => {
    const dead = renderToolMarkdown("graphitlive_scan_dead_code", {
      scopePath: ".",
      entries: [{ filePath: "a.ts", unusedSymbols: [{ name: "x", kind: "Function", line: 3, confidence: "high" }] }],
    });
    expect(dead).toContain("| a.ts | x | Function | 3 | high |");
    expect(renderToolMarkdown("graphitlive_graph_context", { mode: "search", nodes: [] })).toContain("_No node matches the request._");
  });

  it("sizes a code fence past the backtick runs of the markup", () => {
    const text = renderToolMarkdown("graphitlive_export_architecture_diagram", { format: "diagram-spec", markup: "```x```" });
    expect(text).toContain("````json\n```x```\n````");
  });
});
