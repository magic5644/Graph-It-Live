import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { formatParamIssues, parseToolParams, schemaParameters, toolInputSchema } from "../../src/mcp/paramIssues";

const schema = z
  .object({
    filePath: z.string(),
    format: z.enum(["json", "toon"]).optional(),
    depth: z.number().int().min(1).max(10).optional(),
    budget: z.union([z.literal(0), z.number().int().min(500)]).optional(),
    revision: z.string().regex(/^[0-9a-f]{4}$/).optional(),
    tags: z.array(z.string()).max(2).optional(),
    name: z.string().min(2).optional(),
    seeds: z.array(z.object({ file: z.string() }).strict()).optional(),
    flag: z.boolean().optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.filePath === "bad") context.addIssue({ code: "custom", message: "filePath bad is refused" });
  });

function error(params: unknown): string {
  const result = parseToolParams(schema, params);
  if (result.success) throw new Error("expected a failure");
  return result.error;
}

describe("formatParamIssues (#769)", () => {
  it.each([
    [{ filePath: "a", fliePath: "b" }, 'Unknown parameter "fliePath". Did you mean "filePath"? Parameters: filePath, format, depth, budget, revision, tags, name, seeds, flag.'],
    [{}, 'Missing required parameter "filePath" (a string).'],
    [{ filePath: 1 }, '"filePath" must be a string; got 1.'],
    [{ filePath: "a", format: "xml" }, '"format" must be one of json, toon; got "xml".'],
    [{ filePath: "a", depth: 0 }, '"depth" must be >= 1; got 0.'],
    [{ filePath: "a", depth: 11 }, '"depth" must be <= 10; got 11.'],
    [{ filePath: "a", depth: 1.5 }, '"depth" must be an integer; got 1.5.'],
    [{ filePath: "a", budget: 100 }, '"budget" must be >= 500; got 100.'],
    [{ filePath: "a", budget: "x" }, '"budget" must be 0 or a number; got "x".'],
    [{ filePath: "a", revision: "zz" }, '"revision" must be a string matching /^[0-9a-f]{4}$/; got "zz".'],
    [{ filePath: "a", tags: ["a", "b", "c"] }, '"tags" must be at most 2 items; got 3 items.'],
    [{ filePath: "a", name: "x" }, '"name" must be at least 2 characters; got "x".'],
    [{ filePath: "a", seeds: ["x"] }, '"seeds[0]" must be an object; got "x".'],
    [{ filePath: "a", seeds: [{ file: "x", line: 1 }] }, 'Unknown parameter "line" in "seeds[0]".'],
    [{ filePath: "a", flag: "yes" }, '"flag" must be true or false; got "yes".'],
    [{ filePath: "bad" }, "filePath bad is refused"],
  ])("%j → %s", (params, message) => {
    expect(error(params)).toBe(message);
  });

  it("joins several issues in one line, without Zod wording", () => {
    const message = error({ depth: 0, extra: true });
    expect(message).toBe('Missing required parameter "filePath" (a string). "depth" must be >= 1; got 0. Unknown parameter "extra". Parameters: filePath, format, depth, budget, revision, tags, name, seeds, flag.');
    expect(message).not.toMatch(/Invalid input|expected .* received/);
  });

  it("shortens a long received string and keeps a refinement message on a nested path", () => {
    expect(error({ filePath: "a", name: 7 })).toBe('"name" must be a string; got 7.');
    const long = "x".repeat(100);
    expect(error({ filePath: "a", format: long })).toContain(`got "${"x".repeat(57)}..."`);
    const nested = z.object({ seed: z.object({ id: z.string().refine((v) => v !== "", "Seed id must not be empty") }) });
    expect(formatParamIssues(nested, nested.safeParse({ seed: { id: "" } }).error!.issues)).toBe('"seed.id": Seed id must not be empty');
  });

  it("lists the declared parameters of a schema with a transform", () => {
    expect(schemaParameters(z.object({ a: z.string(), b: z.number().optional() }).transform((v) => v))).toEqual(["a", "b"]);
  });
});

describe("toolInputSchema", () => {
  const input = toolInputSchema(schema);

  it("validates with one path-less issue so the SDK prints the message once", async () => {
    const result = await input["~standard"].validate({ filePath: "a", format: "xml" });
    expect(result).toEqual({ issues: [{ message: '"format" must be one of json, toon; got "xml".' }] });
  });

  it("returns the parsed value and keeps the JSON Schema of the Zod schema", async () => {
    expect(await input["~standard"].validate({ filePath: "a" })).toEqual({ value: { filePath: "a" } });
    const json = input["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(json).toMatchObject({ required: ["filePath"], additionalProperties: false });
  });
});
