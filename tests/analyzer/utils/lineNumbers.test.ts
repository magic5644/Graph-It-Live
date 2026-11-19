import { StringUtils } from '@ts-morph/common';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SymbolAnalyzer } from '@/analyzer/SymbolAnalyzer';
import { endLineOf, lineMapBuilds, startLineOf } from '@/analyzer/utils/lineNumbers';

const parse = (text: string) => new Project({ useInMemoryFileSystem: true }).createSourceFile('/w/a.ts', text);

describe('lineNumbers', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['LF', 'const a = 1;\n\n/** doc */\nexport function f() {\n  return a;\n}\nclass C {\n  m() {}\n}'],
    ['CRLF', 'const a = 1;\r\n/** doc */\r\nexport function f() {\r\n  return a;\r\n}\r\n'],
    // Only `\n` counts in ts-morph: a lone `\r` and U+2028 inside a string do not start a line.
    ['lone CR and U+2028', 'const a = 1;\rconst b = "x y";\nconst c = `\n`;\nlet d = c;'],
    ['no trailing newline, first-line node', 'export const x = () => 1'],
  ])('gives the same lines as ts-morph for every node (%s)', (_label, text) => {
    const file = parse(text);
    const nodes = file.getDescendants();
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect([startLineOf(node), endLineOf(node)]).toEqual([node.getStartLineNumber(), node.getEndLineNumber()]);
    }
  });

  it('builds one line map per parsed tree and a new one after the text changes', () => {
    const file = parse('const a = 1;\nconst b = 2;\n');
    const before = lineMapBuilds();
    const b = () => file.getFirstDescendantByKindOrThrow(SyntaxKind.VariableStatement);
    expect(startLineOf(b())).toBe(1);
    expect(endLineOf(b())).toBe(1);
    expect(lineMapBuilds() - before).toBe(1);

    file.replaceWithText('\n\n\nconst a = 1;\n');

    expect(startLineOf(b())).toBe(4);
    expect(lineMapBuilds() - before).toBe(2);
  });

  it('gives line 1 to an empty file', () => {
    const file = parse('');
    expect([startLineOf(file), endLineOf(file)]).toEqual([1, 1]);
  });

  // #774: ts-morph recounted lines from the file start per call: 9 s on an 85k-line file.
  it('analyzes a 50 000-line file with 2 500 symbols in one pass over its lines, same line numbers', () => {
    const FUNCTIONS = 2_500;
    const LINES_PER_FUNCTION = 20;
    const body = Array.from({ length: LINES_PER_FUNCTION - 3 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const text = Array.from(
      { length: FUNCTIONS },
      (_, i) => `export function f${i}(): number {\n${body}\n  return ${i === 0 ? '0' : `f${i - 1}()`};\n}`,
    ).join('\n');
    expect(text.split('\n')).toHaveLength(FUNCTIONS * LINES_PER_FUNCTION);
    const quadraticScans = vi.spyOn(StringUtils, 'getLineNumberAtPos');
    const tsMorphLines = vi.spyOn(Node.prototype, 'getStartLineNumber');
    const builds = lineMapBuilds();

    const { symbols, dependencies } = new SymbolAnalyzer().analyzeFileContent('/w/generated.ts', text);

    expect(symbols).toHaveLength(FUNCTIONS);
    for (const [i, symbol] of symbols.entries()) {
      expect(symbol).toMatchObject({ name: `f${i}`, line: 1 + i * LINES_PER_FUNCTION, endLine: (i + 1) * LINES_PER_FUNCTION });
    }
    const calls = dependencies.filter((dep) => dep.sourceSymbolId.endsWith(':f1'));
    expect(calls.map((dep) => dep.line)).toContain(LINES_PER_FUNCTION + LINES_PER_FUNCTION - 1);
    // Work counter, never wall clock: one line map for the file, no per-node scan of the text.
    expect(lineMapBuilds() - builds).toBe(1);
    expect(quadraticScans).not.toHaveBeenCalled();
    expect(tsMorphLines).not.toHaveBeenCalled();
  });
});
