import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("TypeScript callgraph query patterns", () => {
  it("captures constructor invocations via new_expression", async () => {
    const queryPath = path.join(process.cwd(), "resources", "queries", "typescript.scm");
    const query = await fs.readFile(queryPath, "utf8");

    expect(query).toContain("(new_expression");
    expect(query).toContain("constructor: (identifier) @call");
    // Tree-sitter uses `identifier` (not `type_identifier`) in expression positions
    expect(query).not.toContain("constructor: (type_identifier)");
  });

  it("captures extends clauses using identifier (expression position)", async () => {
    const queryPath = path.join(process.cwd(), "resources", "queries", "typescript.scm");
    const query = await fs.readFile(queryPath, "utf8");

    expect(query).toContain("value: (identifier) @inherit");
    // Tree-sitter extends_clause value is an expression — uses identifier, not type_identifier
    expect(query).not.toContain("value: (type_identifier) @inherit");
  });

  it("captures member_expression patterns for namespaced calls", async () => {
    const queryPath = path.join(process.cwd(), "resources", "queries", "typescript.scm");
    const query = await fs.readFile(queryPath, "utf8");

    // new ns.Foo()
    expect(query).toContain("constructor: (member_expression");
    // ns.Bar in extends
    expect(query).toContain("property: (property_identifier) @inherit");
  });
});
