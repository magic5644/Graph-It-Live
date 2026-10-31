import { describe, expect, it } from "vitest";
import { maskNonCode } from "@/analyzer/utils/maskNonCode";

describe("maskNonCode", () => {
  it.each<[string, string, string]>([
    ["line comment", "a; // b 'c'\nd", "a;" + " ".repeat(9) + "\nd"],
    ["block comment over lines", "a /* b\n c */ d", "a     \n      d"],
    ["unterminated block comment", "a /* b", "a     "],
    ["single and double quotes", `x('ab', "c d")`, `x('  ', "   ")`],
    ["escaped quotes", String.raw`'it\'s' "say \"hi\""`, `'     ' "          "`],
    ["unterminated string stops at the line end", "'abc\nd", "'   \nd"],
    ["template text masked, expression kept", "`a ${b('c')} d`", "`  ${b(' ')}  `"],
    ["nested template in an expression", "`a ${`b ${c}`} d`", "`  ${`  ${c}`}  `"],
    ["object literal in an expression", "`${ {a: 'x'}.a } y`", "`${ {a: ' '}.a }  `"],
    ["regex after =", "r = /a'b/g;", "r = /   /g;"],
    ["regex after (", "f(/`[/]x/)", "f(/     /)"],
    ["regex after return", "return /a\"/.test(s)", "return /  /.test(s)"],
    ["division after a value", "a / b / c", "a / b / c"],
    ["division after )", "(a) / 2 / 'x'", "(a) / 2 / ' '"],
    ["division after ]", "x[0] / y / z", "x[0] / y / z"],
    ["slash without a closing slash on the line", "a = / b\n'c'", "a = / b\n' '"],
    ["CRLF line endings", "// a\r\n'b'\r\n", "    \r\n' '\r\n"],
  ])("%s", (_title, source, expected) => {
    expect(maskNonCode(source)).toBe(expected);
  });

  it("keeps the UTF-16 length with astral characters", () => {
    const source = "const s = '😀 import x from \"./x\"'; import y from './y';";
    const masked = maskNonCode(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.indexOf("import y")).toBe(source.indexOf("import y"));
  });

  it("returns an empty string unchanged", () => {
    expect(maskNonCode("")).toBe("");
  });
});
