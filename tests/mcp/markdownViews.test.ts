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

  it("says when imports resolve to no file, with examples, in the index status and the dead-code scan (#774)", () => {
    const unresolvedImports = {
      count: 3,
      examples: [{ file: "src/loader.ts", specifier: "./gen" }],
      excludedCount: 1,
      excludedExamples: [{ file: "src/b.ts", specifier: "./ignored" }],
      next: "Run the codegen.",
    };
    for (const tool of ["graphitlive_get_index_status", "graphitlive_scan_dead_code"]) {
      const text = renderToolMarkdown(tool, { scopePath: ".", unresolvedImports });
      expect(text).toContain("**Unresolved imports: 3 resolving to no file, 1 to a file excluded from the analysis.** Files they would import may be listed as unused. Run the codegen.");
      expect(text).toContain("| src/loader.ts | ./gen |");
      expect(text).toContain("## Excluded import examples (1)");
      expect(renderToolMarkdown(tool, { scopePath: ".", unresolvedImports: { count: 0, examples: [], excludedCount: 0, excludedExamples: [] } })).not.toContain("Unresolved");
    }
  });

  it("sizes a code fence past the backtick runs of the markup", () => {
    const text = renderToolMarkdown("graphitlive_export_architecture_diagram", { format: "diagram-spec", markup: "```x```" });
    expect(text).toContain("````json\n```x```\n````");
  });

  it("keeps a heading on one line and a diagram fence multi-line", () => {
    const workspace = renderToolMarkdown("graphitlive_set_workspace", { workspaceName: "evil\n# Injected", message: "ok" });
    expect(workspace).toContain("# Workspace evil # Injected");
    const diagram = renderToolMarkdown("graphitlive_export_architecture_diagram", { format: "mermaid", markup: "flowchart LR\n  a --> b" });
    expect(diagram).toContain("flowchart LR\n  a --> b");
  });
});
