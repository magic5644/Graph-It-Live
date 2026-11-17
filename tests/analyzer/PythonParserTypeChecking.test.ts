import { PythonParser } from '@/analyzer/languages/PythonParser';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real tree-sitter WASM (dist/wasm): `if TYPE_CHECKING:` imports are type-only, like `import type` (#745).
describe('PythonParser TYPE_CHECKING imports', () => {
  let root: string;
  let parser: PythonParser;

  const parse = async (source: string) => {
    const file = path.join(root, `case-${Math.random().toString(36).slice(2)}.py`);
    await fs.writeFile(file, source);
    const deps = await parser.parseImports(file);
    return Object.fromEntries(deps.map((dep) => [dep.module, dep.typeOnly === true]));
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'py-type-checking-'));
    await fs.mkdir(path.join(root, 'pkg'));
    await fs.writeFile(path.join(root, 'pkg', '__init__.py'), '');
    await fs.writeFile(path.join(root, 'pkg', 'sub.py'), '');
    parser = new PythonParser(root, process.cwd());
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('flags imports in the body of if TYPE_CHECKING and if typing.TYPE_CHECKING', async () => {
    expect(await parse([
      'import typing',
      'from typing import TYPE_CHECKING',
      'if TYPE_CHECKING:',
      '    from .models import User',
      'if typing.TYPE_CHECKING:',
      '    import app.services',
      'import app.runtime',
    ].join('\n'))).toEqual({ typing: false, '.models': true, 'app.services': true, 'app.runtime': false });
  }, 30_000);

  it('keeps else branches and other conditions runtime', async () => {
    expect(await parse([
      'if TYPE_CHECKING:',
      '    from .a import X',
      'else:',
      '    from .b import Y',
      'if not TYPE_CHECKING:',
      '    import c',
      'if MY_TYPE_CHECKING_FLAG:',
      '    import d',
    ].join('\n'))).toEqual({ '.a': true, '.b': false, c: false, d: false });
  }, 30_000);

  it('keeps a module runtime when one of its imports is runtime, in either order', async () => {
    expect(await parse([
      'if TYPE_CHECKING:',
      '    import first',
      '    import second',
      'import first',
      'import second',
      'if TYPE_CHECKING:',
      '    import first',
      '    import third',
    ].join('\n'))).toEqual({ first: false, second: false, third: true });
  }, 30_000);

  it('flags the submodules a type-only from-import names', async () => {
    expect(await parse('if TYPE_CHECKING:\n    from pkg import sub\n')).toEqual({ pkg: true, 'pkg.sub': true });
  }, 30_000);

  it('reports no flag on a file without TYPE_CHECKING', async () => {
    expect(await parse('import os\nfrom pkg import sub\n')).toEqual({ os: false, pkg: false, 'pkg.sub': false });
  }, 30_000);
});
