import { describe, expect, it } from 'vitest';
import { isPublicPythonName, pythonDeclarations } from '@/analyzer/utils/pythonSignatures';

const params = (source: string) => pythonDeclarations(source).functions[0]?.parameters;

describe('pythonDeclarations (#524)', () => {
  it('reads top-level functions, classes and assignments with their lines', () => {
    const { functions, names } = pythonDeclarations([
      'import os',
      'LIMIT = 3',
      'TIMEOUT: float = 1.5',
      '',
      '@decorator',
      'def run(a, b=1) -> int:',
      '    inner = 2',
      '    def nested(): pass',
      '    return a',
      '',
      'async def fetch(url: str):',
      '    pass',
      'class Box(Base):',
      '    def area(self): return 1',
    ].join('\n'));

    expect([...names]).toEqual([
      ['LIMIT', { kind: 'variable', line: 2 }],
      ['TIMEOUT', { kind: 'variable', line: 3 }],
      ['run', { kind: 'function', line: 6 }],
      ['fetch', { kind: 'function', line: 11 }],
      ['Box', { kind: 'class', line: 13 }],
    ]);
    expect(functions.map(({ name, isAsync, returnType, line }) => ({ name, isAsync, returnType, line }))).toEqual([
      { name: 'run', isAsync: false, returnType: 'int', line: 6 },
      { name: 'fetch', isAsync: true, returnType: '', line: 11 },
    ]);
  });

  it.each([
    ['plain and defaulted', 'def f(a, b=1): pass', [['a', '', false, false], ['b', '', true, false]]],
    ['annotated with a default', 'def f(a: int = 2): pass', [['a', 'int', true, false]]],
    ['rest parameters', 'def f(*args, **kwargs): pass', [['args', '', false, true], ['kwargs', '', false, true]]],
    ['keyword-only and positional-only markers', 'def f(a, /, b, *, c=1): pass', [['a', '', false, false], ['b', '', false, false], ['c', '', true, false]]],
    ['brackets and commas inside annotations and defaults', 'def f(a: dict[str, int] = {"x": (1, 2)}, b=g(1, 2)): pass', [['a', 'dict[str, int]', true, false], ['b', '', true, false]]],
    ['a header split over lines, with a trailing comma', 'def f(\n    a,\n    b: int,\n):\n    pass', [['a', '', false, false], ['b', 'int', false, false]]],
    ['a lambda default', 'def f(key=lambda x: x): pass', [['key', '', true, false]]],
    ['no parameter', 'def f(): pass', []],
  ])('parses %s', (_label, source, expected) => {
    expect(params(source)?.map((p) => [p.name, p.type, p.hasDefault, p.isRest])).toEqual(expected);
  });

  it('numbers positions and marks rest parameters optional', () => {
    expect(params('def f(a, *rest): pass')).toEqual([
      { name: 'a', type: '', isOptional: false, hasDefault: false, isRest: false, position: 0 },
      { name: 'rest', type: '', isOptional: true, hasDefault: false, isRest: true, position: 1 },
    ]);
  });

  it('reads a return annotation containing brackets and a colon-free tail', () => {
    expect(pythonDeclarations('def f(a) -> dict[str, list[int]]:\n    pass').functions[0].returnType).toBe('dict[str, list[int]]');
  });

  it.each([
    ['indented definitions', 'if True:\n    def f(): pass\n    X = 1\n'],
    ['definitions inside strings and comments', '"""\ndef f(): pass\n"""\n# def g(): pass\nDOC = """\nclass C: pass\n"""\n'],
    ['comparisons and augmented assignments', 'x == 1\ncount += 1\n'],
    ['an annotation without a value', 'name: str\n'],
  ])('ignores %s', (_label, source) => {
    const { functions, names } = pythonDeclarations(source);
    expect(functions).toEqual([]);
    expect([...names.keys()].filter((name) => name !== 'DOC')).toEqual([]);
  });

  it.each([
    ['no parenthesis', 'def f:\n    pass\n'],
    ['an unclosed parameter list', 'def f(a, b\n'],
    ['text between the name and the parenthesis', 'def f x(a): pass\n'],
  ])('keeps the name but no signature for a malformed header: %s', (_label, source) => {
    const { functions, names } = pythonDeclarations(source);
    expect(functions).toEqual([]);
    expect(names.get('f')?.kind).toBe('function');
  });

  it('keeps the first binding of a name assigned twice, and lets a later def take it over', () => {
    const { names } = pythonDeclarations('X = 1\nX = 2\ndef X(): pass\n');
    expect(names.get('X')).toEqual({ kind: 'function', line: 3 });
  });

  it('keeps line numbers after a backslash continuation, and reads a return annotation after one', () => {
    const { functions, names } = pythonDeclarations('TOTAL = 1 + \\\n    2\ndef f(a) \\\r\n    -> int:\n    pass\nclass C: pass\n');
    expect(names.get('TOTAL')?.line).toBe(1);
    expect(functions[0]).toMatchObject({ name: 'f', line: 3, returnType: 'int' });
    expect(names.get('C')?.line).toBe(6);
  });

  it('does not read a one-line block header as a variable', () => {
    const { names } = pythonDeclarations('try: X = load()\nexcept ImportError: X = None\nelse: Y = 1\nfinally: Z = 2\n');
    expect([...names.keys()]).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const { functions } = pythonDeclarations('def f(a):\r\n    pass\r\ndef g(b=1):\r\n    pass\r\n');
    expect(functions.map((fn) => [fn.name, fn.line, fn.parameters.map((p) => p.name)])).toEqual([['f', 1, ['a']], ['g', 3, ['b']]]);
  });

  it('returns nothing for an empty module', () => {
    expect(pythonDeclarations('')).toEqual({ functions: [], names: new Map() });
  });
});

describe('isPublicPythonName', () => {
  it.each([
    ['run', true],
    ['_private', false],
    ['__mangled', false],
    ['__version__', true],
    ['__init__', true],
  ])('%s → %s', (name, expected) => {
    expect(isPublicPythonName(name)).toBe(expected);
  });
});
