import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/shared/path';

const repoRoot = path.resolve(__dirname, '..', '..');
const fixtureRoot = path.join(repoRoot, 'tests/fixtures/python-integration');

describe('Python import resolution', () => {
  let spider: Spider;

  beforeAll(() => {
    spider = new Spider({
      rootDir: repoRoot,
      enableReverseIndex: true,
    });
  });

  afterAll(async () => {
    await spider.dispose();
  });

  beforeEach(() => {
    spider.clearCache();
  });

  it('resolves absolute-style imports relative to source directories', async () => {
    const appPath = path.join(fixtureRoot, 'app.py');
    const deps = await spider.analyze(appPath);

    const depPaths = deps.map((dep) => dep.path);

    expect(depPaths).toContain(normalizePath(path.join(fixtureRoot, 'utils/database.py')));
    expect(depPaths).toContain(normalizePath(path.join(fixtureRoot, 'utils/helpers.py')));
    expect(depPaths).toContain(normalizePath(path.join(fixtureRoot, 'services/processor.py')));
    expect(deps).toHaveLength(3);
  });

  it('populates reverse index for python files', async () => {
    const appPath = path.join(fixtureRoot, 'app.py');
    const databasePath = path.join(fixtureRoot, 'utils/database.py');
    const helperPath = path.join(fixtureRoot, 'utils/helpers.py');
    const processorPath = path.join(fixtureRoot, 'services/processor.py');

    await spider.analyze(appPath);
    await spider.analyze(databasePath);
    await spider.analyze(processorPath);

    const refs = await spider.findReferencingFiles(helperPath);
    const refPaths = refs.map((ref) => normalizePath(ref.path));

    expect(refPaths).toContain(normalizePath(appPath));
    expect(refPaths).toContain(normalizePath(databasePath));
    expect(refPaths).toContain(normalizePath(processorPath));
  });
});
