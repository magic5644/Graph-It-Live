import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Spider } from '../../../src/analyzer/Spider';
import { SpiderBuilder } from '../../../src/analyzer/SpiderBuilder';
import {
  CallGraphIndexer,
  type CallGraphEdge,
  type CallGraphNode,
} from '../../../src/analyzer/callgraph/CallGraphIndexer';
import { GraphContextFederator } from '../../../src/analyzer/graph-context/GraphContextFederator';
import { normalizePath } from '../../../src/shared/path';

const require = createRequire(import.meta.url);
const SQL_WASM_PATH: string = require.resolve('sql.js/dist/sql-wasm.wasm');

describe('GraphContextFederator', () => {
  let workspaceRoot: string;
  let spider: Spider;
  let indexer: CallGraphIndexer;

  beforeEach(async () => {
    workspaceRoot = normalizePath(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-context-federator-')));
    await writeFixture(workspaceRoot);

    spider = new SpiderBuilder()
      .withRootDir(workspaceRoot)
      .withMaxDepth(1)
      .withReverseIndex(true)
      .build();
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
    await indexFixture(indexer, workspaceRoot);
  });

  afterEach(async () => {
    await spider.dispose();
    indexer.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('federates stable file and symbol IDs without mutating Spider or SQLite indexes', async () => {
    const federator = new GraphContextFederator(spider, indexer);
    const indexedBefore = Array.from(indexer.exportDb());
    const spiderStateBefore = getSpiderIndexState(spider);

    expect(spider.isReverseIndexEnabled()).toBe(true);

    const first = await federator.buildSnapshot({ question: 'trace user service' });
    const second = await federator.buildSnapshot({ question: 'trace user service' });

    expect(first).toEqual(second);
    expect(Array.from(indexer.exportDb())).toEqual(indexedBefore);
    expect(getSpiderIndexState(spider)).toEqual(spiderStateBefore);
    expect(first.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file:src/services/UserService.ts', kind: 'file' }),
      expect.objectContaining({ id: 'symbol:src/services/UserService.ts:UserService:12', kind: 'symbol' }),
      expect.objectContaining({ id: 'symbol:src/controllers/UserController.ts:UserService:8', kind: 'symbol' }),
      expect.objectContaining({ id: 'test:tests/services/UserService.test.ts:UserServiceTest:7', kind: 'test' }),
    ]));
    expect(first.nodes.filter(node => node.name === 'UserService' && node.kind === 'symbol')).toHaveLength(2);
    expect(first.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'file:src/services/UserService.ts',
        target: 'symbol:src/services/UserService.ts:UserService:12',
        relation: 'CONTAINS',
      }),
      expect.objectContaining({
        source: 'file:src/services/UserService.ts',
        target: 'file:src/types/User.ts',
        relation: 'IMPORTS',
        confidence: 'RESOLVED',
        sourceLine: 1,
        evidence: {
          sourcePath: 'src/services/UserService.ts',
          sourceLine: 1,
          reason: 'Import target resolved to a workspace file.',
        },
      }),
      expect.objectContaining({
        source: 'symbol:src/controllers/UserController.ts:UserService:8',
        target: 'symbol:src/services/UserService.ts:UserService:12',
        relation: 'CALLS',
        confidence: 'EXTRACTED',
        sourceLine: 9,
      }),
      expect.objectContaining({
        source: 'symbol:src/controllers/UserController.ts:UserService:8',
        target: 'external:unresolvedExternal',
        relation: 'CALLS',
      }),
    ]));
    expect(first.nodes).toContainEqual(expect.objectContaining({
      id: 'external:unresolvedExternal',
      kind: 'external',
    }));
    expect(first.edges).toContainEqual(expect.objectContaining({
      source: 'symbol:src/controllers/UserController.ts:UserService:8',
      target: 'external:UserService',
      relation: 'CALLS',
      confidence: 'AMBIGUOUS',
      evidence: expect.objectContaining({
        sourcePath: 'src/controllers/UserController.ts',
        sourceLine: 11,
      }),
    }));
  });

  it('applies scope before adding files, symbols, and edges', async () => {
    const federator = new GraphContextFederator(spider, indexer);

    const snapshot = await federator.buildSnapshot({
      question: 'show service only',
      scope: 'src/services/**',
    });

    expect(snapshot.nodes.map(node => node.id)).toEqual([
      'file:src/services/UserService.ts',
      'symbol:src/services/UserService.ts:UserService:12',
    ]);
    expect(snapshot.edges).toEqual([
      expect.objectContaining({
        source: 'file:src/services/UserService.ts',
        target: 'symbol:src/services/UserService.ts:UserService:12',
        relation: 'CONTAINS',
      }),
    ]);
  });

  it('loads an exact document ID seed without requiring scope', async () => {
    const federator = new GraphContextFederator(spider, indexer);

    const defaultSnapshot = await federator.buildSnapshot({ question: 'code only' });
    const seededSnapshot = await federator.buildSnapshot({
      seeds: [{ id: 'document:docs/ADR.md' }],
    });

    expect(defaultSnapshot.nodes.some(node => node.kind === 'document')).toBe(false);
    expect(seededSnapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'document:docs/ADR.md',
      kind: 'document',
      path: 'docs/ADR.md',
    }));
  });

  it('marks the snapshot stale when a source file changes after indexing', async () => {
    const federator = new GraphContextFederator(spider, indexer);
    const beforeChange = await federator.buildSnapshot({ question: 'check freshness' });
    const servicePath = path.join(workspaceRoot, 'src/services/UserService.ts');

    await fs.appendFile(servicePath, '\nexport const changed = true;\n');
    const changedAt = new Date(Date.now() + 2_000);
    await fs.utimes(servicePath, changedAt, changedAt);

    const afterChange = await federator.buildSnapshot({ question: 'check freshness' });

    expect(beforeChange.fresh).toBe(true);
    expect(afterChange.fresh).toBe(false);
    expect(afterChange.revision).not.toBe(beforeChange.revision);
    expect(afterChange.edges).toContainEqual(expect.objectContaining({
      source: 'file:src/services/UserService.ts',
      target: 'file:src/types/User.ts',
      confidence: 'STALE',
    }));
  });
});

async function writeFixture(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, 'src/services'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src/controllers'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src/types'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'tests/services'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceRoot, 'src/types/User.ts'), 'export interface User { id: string; }\n'),
    fs.writeFile(path.join(workspaceRoot, 'src/services/UserService.ts'), [
      "import type { User } from '../types/User';",
      '',
      'export function UserService(user: User): User {',
      '  return user;',
      '}',
      '',
    ].join('\n')),
    fs.writeFile(path.join(workspaceRoot, 'src/controllers/UserController.ts'), [
      "import { UserService as implementation } from '../services/UserService';",
      '',
      'export function UserService(): string {',
      '  implementation({ id: \'user-1\' });',
      "  return 'user';",
      '}',
      '',
    ].join('\n')),
    fs.writeFile(path.join(workspaceRoot, 'tests/services/UserService.test.ts'), [
      "import { UserService } from '../../src/controllers/UserController';",
      '',
      'export function UserServiceTest(): string {',
      '  return UserService();',
      '}',
      '',
    ].join('\n')),
    fs.writeFile(path.join(workspaceRoot, 'docs/ADR.md'), '# Stable gateway\n'),
  ]);
}

async function indexFixture(indexer: CallGraphIndexer, workspaceRoot: string): Promise<void> {
  const typePath = path.join(workspaceRoot, 'src/types/User.ts');
  const servicePath = path.join(workspaceRoot, 'src/services/UserService.ts');
  const controllerPath = path.join(workspaceRoot, 'src/controllers/UserController.ts');
  const testPath = path.join(workspaceRoot, 'tests/services/UserService.test.ts');
  const serviceNode = makeNode(servicePath, 'UserService', 12);
  const controllerNode = makeNode(controllerPath, 'UserService', 8);
  const testNode = makeNode(testPath, 'UserServiceTest', 7);

  await Promise.all([
    indexFile(indexer, typePath, []),
    indexFile(indexer, servicePath, [serviceNode]),
    indexFile(indexer, controllerPath, [controllerNode], [
      makeEdge(controllerNode.id, serviceNode.id, 9),
      makeEdge(controllerNode.id, '@@external:unresolvedExternal', 10),
      makeEdge(controllerNode.id, '@@external:UserService', 11),
    ]),
    indexFile(indexer, testPath, [testNode], [makeEdge(testNode.id, controllerNode.id, 8)]),
  ]);
}

async function indexFile(
  indexer: CallGraphIndexer,
  filePath: string,
  nodes: CallGraphNode[],
  edges: CallGraphEdge[] = [],
): Promise<void> {
  const mtime = (await fs.stat(filePath)).mtimeMs;
  indexer.indexFile(nodes, edges, normalizePath(filePath), 'typescript', mtime);
}

function makeNode(filePath: string, name: string, startLine: number): CallGraphNode {
  const normalizedPath = normalizePath(filePath);
  return {
    id: `${normalizedPath}:${name}:${startLine}`,
    name,
    type: 'function',
    lang: 'typescript',
    path: normalizedPath,
    folder: normalizePath(path.dirname(filePath)),
    startLine,
    endLine: startLine + 2,
    startCol: 0,
    isExported: true,
  };
}

function makeEdge(sourceId: string, targetId: string, sourceLine: number): CallGraphEdge {
  return { sourceId, targetId, typeRelation: 'CALLS', sourceLine };
}

function getSpiderIndexState(spider: Spider): {
  cacheStats: ReturnType<Spider['getCacheStats']>;
  reverseIndex: {
    version: number;
    rootDir: string;
    reverseMap: Record<string, unknown>;
    fileHashes: Record<string, unknown>;
  } | null;
} {
  const serializedReverseIndex = spider.getSerializedReverseIndex();

  return {
    cacheStats: spider.getCacheStats(),
    reverseIndex: serializedReverseIndex === null
      ? null
      : readStableReverseIndexState(serializedReverseIndex),
  };
}

function readStableReverseIndexState(serializedReverseIndex: string): {
  version: number;
  rootDir: string;
  reverseMap: Record<string, unknown>;
  fileHashes: Record<string, unknown>;
} {
  const parsed = JSON.parse(serializedReverseIndex) as {
    version: number;
    rootDir: string;
    reverseMap: Record<string, unknown>;
    fileHashes: Record<string, unknown>;
  };
  return {
    version: parsed.version,
    rootDir: parsed.rootDir,
    reverseMap: parsed.reverseMap,
    fileHashes: parsed.fileHashes,
  };
}
