/// <reference types="node" />

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryEngine } from '../../../src/analyzer/QueryEngine';
import { GraphContextRetriever } from '../../../src/analyzer/graph-context/GraphContextRetriever';
import { GraphContextScorer } from '../../../src/analyzer/graph-context/GraphContextScorer';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextRequest,
  GraphContextSnapshot,
} from '../../../src/shared/graph-context-types';

const require = createRequire(import.meta.url);
const SQL_WASM_PATH: string = require.resolve('sql.js/dist/sql-wasm.wasm');
const WORKSPACE_ROOT = '/workspace';

const IDS = {
  authControllerFile: 'file:src/api/AuthController.ts',
  authController: 'symbol:src/api/AuthController.ts:AuthController:4',
  authServiceFile: 'file:src/auth/AuthService.ts',
  authenticate: 'symbol:src/auth/AuthService.ts:authenticate:8',
  authGateway: 'symbol:src/auth/AuthGateway.ts:AuthGateway:3',
  adminAuthGateway: 'symbol:src/admin/AuthGateway.ts:AuthGateway:3',
  tokenVerifier: 'symbol:src/auth/TokenVerifier.ts:verifyToken:5',
  userRepository: 'symbol:src/data/UserRepository.ts:findUser:7',
  databasePool: 'symbol:src/data/DatabasePool.ts:DatabasePool:2',
  authContractTest: 'test:tests/auth/AuthContract.test.ts:AuthContractTest:6',
  outOfScopeAuth: 'symbol:vendor/AuthVendor.ts:authenticateVendor:1',
} as const;

const node = (
  id: string,
  kind: GraphContextNode['kind'],
  name: string,
  filePath: string,
  startLine?: number,
): GraphContextNode => ({ id, kind, name, path: filePath, startLine });

const edge = (
  source: string,
  target: string,
  relation: GraphContextEdge['relation'],
): GraphContextEdge => ({ source, target, relation, confidence: 'EXTRACTED' });

const snapshot: GraphContextSnapshot = {
  revision: 'retrieval-golden-v1',
  fresh: true,
  nodes: [
    node(IDS.authControllerFile, 'file', 'AuthController.ts', 'src/api/AuthController.ts'),
    node(IDS.authController, 'symbol', 'AuthController', 'src/api/AuthController.ts', 4),
    node(IDS.authServiceFile, 'file', 'AuthService.ts', 'src/auth/AuthService.ts'),
    node(IDS.authenticate, 'symbol', 'authenticate', 'src/auth/AuthService.ts', 8),
    node(IDS.authGateway, 'symbol', 'AuthGateway', 'src/auth/AuthGateway.ts', 3),
    node(IDS.adminAuthGateway, 'symbol', 'AuthGateway', 'src/admin/AuthGateway.ts', 3),
    node(IDS.tokenVerifier, 'symbol', 'verifyToken', 'src/auth/TokenVerifier.ts', 5),
    node(IDS.userRepository, 'symbol', 'findUser', 'src/data/UserRepository.ts', 7),
    node(IDS.databasePool, 'symbol', 'DatabasePool', 'src/data/DatabasePool.ts', 2),
    node(IDS.authContractTest, 'test', 'AuthContractTest', 'tests/auth/AuthContract.test.ts', 6),
    node(IDS.outOfScopeAuth, 'symbol', 'authenticateVendor', 'vendor/AuthVendor.ts', 1),
  ],
  edges: [
    edge(IDS.authControllerFile, IDS.authController, 'CONTAINS'),
    edge(IDS.authServiceFile, IDS.authenticate, 'CONTAINS'),
    edge(IDS.authControllerFile, IDS.authServiceFile, 'IMPORTS'),
    edge(IDS.authController, IDS.authenticate, 'CALLS'),
    edge(IDS.authenticate, IDS.tokenVerifier, 'CALLS'),
    edge(IDS.tokenVerifier, IDS.userRepository, 'CALLS'),
    edge(IDS.userRepository, IDS.databasePool, 'USES'),
    edge(IDS.authenticate, IDS.authGateway, 'IMPLEMENTS'),
    edge(IDS.authContractTest, IDS.authGateway, 'CALLS'),
    edge(IDS.outOfScopeAuth, IDS.authenticate, 'CALLS'),
  ],
};

const SCHEMA_SQL = `
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'typescript',
    path TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    start_line INTEGER,
    end_line INTEGER,
    start_col INTEGER DEFAULT 0,
    is_exported INTEGER DEFAULT 0,
    indexed_at INTEGER
  );
  CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type_relation TEXT NOT NULL DEFAULT 'CALLS',
    is_cyclic INTEGER DEFAULT 0,
    source_line INTEGER DEFAULT 0
  );
`;

describe('GraphContextRetriever golden modes', () => {
  let db: Database;
  let retriever: GraphContextRetriever;

  beforeEach(async () => {
    const wasmBinary = await readFile(SQL_WASM_PATH);
    const SQL = await initSqlJs({ wasmBinary });
    db = new SQL.Database();
    db.run(SCHEMA_SQL);
    for (const graphNode of snapshot.nodes.filter(candidate => candidate.kind !== 'file')) {
      db.run(
        `INSERT INTO nodes (id, name, type, path, folder, start_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `raw:${graphNode.id}`,
          graphNode.name,
          graphNode.kind,
          `${WORKSPACE_ROOT}/${graphNode.path}`,
          'src',
          graphNode.startLine ?? null,
        ],
      );
    }

    retriever = new GraphContextRetriever({
      snapshotProvider: {
        buildSnapshot: async (_request: GraphContextRequest) => snapshot,
      },
      queryEngine: new QueryEngine(db, null),
      dependentsProvider: {
        findReferencingFiles: async (targetPath: string) => (
          targetPath.endsWith('/src/auth/AuthService.ts')
            ? [{ path: `${WORKSPACE_ROOT}/src/api/AuthController.ts` }]
            : []
        ),
        getSymbolDependents: async (_filePath: string, symbolName: string) => {
          if (symbolName === 'AuthGateway') {
            return [
              { sourceSymbolId: `${WORKSPACE_ROOT}/src/auth/AuthService.ts:authenticate` },
              { sourceSymbolId: `${WORKSPACE_ROOT}/tests/auth/AuthContract.test.ts:AuthContractTest` },
            ];
          }
          if (symbolName === 'authenticate') {
            return [{
              sourceSymbolId: `${WORKSPACE_ROOT}/src/api/AuthController.ts:AuthController`,
            }];
          }
          return [];
        },
      },
      workspaceRoot: WORKSPACE_ROOT,
    });
  });

  afterEach(() => db.close());

  it('retrieves the authentication flow from locally ranked search seeds', async () => {
    const response = await retriever.retrieve({
      question: 'How does authenticate flow through AuthService?',
      mode: 'search',
      scope: 'src/**',
      depth: 2,
    });

    expect(response.seeds.map(seed => seed.id)).toContain(IDS.authenticate);
    expect(response.seeds.map(seed => seed.id)).not.toContain(IDS.outOfScopeAuth);
    expect(response.edges.map(result => result.relation)).toContain('CALLS');
    expect(response.nodes.map(result => result.id)).toEqual(expect.arrayContaining([
      IDS.authController,
      IDS.authenticate,
      IDS.tokenVerifier,
    ]));
    expect(response.nextQueries.every(suggestion => (
      suggestion.includes('src/') || suggestion.includes('Auth') || suggestion.includes('authenticate')
    ))).toBe(true);
  });

  it('returns exact incoming and outgoing callers for a resolved symbol', async () => {
    const response = await retriever.retrieve({
      question: 'What exactly calls authenticate?',
      mode: 'neighbors',
      seeds: [{ filePath: 'src/auth/AuthService.ts', symbolName: 'authenticate' }],
      relations: ['CALLS'],
    });

    expect(response.seeds.map(seed => seed.id)).toEqual([IDS.authenticate]);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: IDS.authController, target: IDS.authenticate, relation: 'CALLS' }),
      expect.objectContaining({ source: IDS.authenticate, target: IDS.tokenVerifier, relation: 'CALLS' }),
    ]));
    expect(response.nextQueries).toContain(
      'Explore CONTAINS around authenticate in src/auth/AuthService.ts',
    );
  });

  it('ranks direct file impact ahead of transitive dependents', async () => {
    const response = await retriever.retrieve({
      question: 'What is the impact of changing AuthService.ts?',
      mode: 'impact',
      seeds: [{ filePath: 'src/auth/AuthService.ts' }],
      depth: 2,
    });

    expect(response.seeds.map(seed => seed.id)).toEqual([IDS.authServiceFile]);
    expect(response.edges).toContainEqual(expect.objectContaining({
      source: IDS.authControllerFile,
      target: IDS.authServiceFile,
      relation: 'IMPORTS',
    }));
    expect(response.edges).toContainEqual(expect.objectContaining({
      source: IDS.authControllerFile,
      target: IDS.authServiceFile,
      relation: 'IMPACTED_BY',
    }));
    expect(response.nodes.find(result => result.id === IDS.authControllerFile)?.score).toBe(0.5);
  });

  it('loads file dependents for a question-only impact request', async () => {
    const serviceId = 'file:src/billing/InvoiceService.ts';
    const apiId = 'file:src/api/BillingApi.ts';
    const questionSnapshot: GraphContextSnapshot = {
      revision: 'question-impact',
      fresh: true,
      nodes: [
        node(serviceId, 'file', 'InvoiceService.ts', 'src/billing/InvoiceService.ts'),
        node(apiId, 'file', 'BillingApi.ts', 'src/api/BillingApi.ts'),
      ],
      edges: [],
    };
    const questionRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => questionSnapshot },
      dependentsProvider: {
        findReferencingFiles: async () => [{ path: `${WORKSPACE_ROOT}/src/api/BillingApi.ts` }],
        getSymbolDependents: async () => [],
      },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await questionRetriever.retrieve({
      question: 'What depends on the InvoiceService file?',
      mode: 'impact',
      maxNodes: 2,
    });

    expect(response.seeds.map(seed => seed.id)).toEqual([serviceId]);
    expect(response.edges).toContainEqual(expect.objectContaining({
      source: apiId,
      target: serviceId,
      relation: 'IMPACTED_BY',
    }));
  });

  it('loads symbol dependents for a question-only refactor request', async () => {
    const gatewayId = 'symbol:src/billing/BillingGateway.ts:BillingGateway:3';
    const coordinatorId = 'symbol:src/checkout/Coordinator.ts:CheckoutCoordinator:7';
    const questionSnapshot: GraphContextSnapshot = {
      revision: 'question-refactor',
      fresh: true,
      nodes: [
        node(gatewayId, 'symbol', 'BillingGateway', 'src/billing/BillingGateway.ts', 3),
        node(coordinatorId, 'symbol', 'CheckoutCoordinator', 'src/checkout/Coordinator.ts', 7),
      ],
      edges: [],
    };
    const questionRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => questionSnapshot },
      dependentsProvider: {
        findReferencingFiles: async () => [],
        getSymbolDependents: async () => [{
          sourceSymbolId: `${WORKSPACE_ROOT}/src/checkout/Coordinator.ts:CheckoutCoordinator`,
        }],
      },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await questionRetriever.retrieve({
      question: 'Which implementations change if I refactor BillingGateway?',
      mode: 'refactor',
      maxNodes: 2,
    });

    expect(response.seeds.map(seed => seed.id)).toEqual([gatewayId]);
    expect(response.edges).toContainEqual(expect.objectContaining({
      source: coordinatorId,
      target: gatewayId,
      relation: 'IMPACTED_BY',
    }));
  });

  it('prioritizes implementations, runtime callers, and tests for an interface refactor', async () => {
    const response = await retriever.retrieve({
      question: 'What must change if I refactor the AuthGateway interface?',
      mode: 'refactor',
      seeds: [{ filePath: 'src/auth/AuthGateway.ts', symbolName: 'AuthGateway' }],
      depth: 2,
    });

    expect(response.seeds.map(seed => seed.id)).toEqual([IDS.authGateway]);
    expect(response.edges.map(result => result.relation)).toEqual(expect.arrayContaining([
      'IMPLEMENTS',
      'CALLS',
    ]));
    const orderedIds = response.nodes.map(result => result.id);
    expect(orderedIds.indexOf(IDS.authenticate)).toBeLessThan(orderedIds.indexOf(IDS.authContractTest));
    expect(orderedIds.indexOf(IDS.authController)).toBeLessThan(orderedIds.indexOf(IDS.authContractTest));
  });

  it('returns a controller-to-database path with positional response edge indexes', async () => {
    const response = await retriever.retrieve({
      question: 'How does AuthController reach DatabasePool?',
      mode: 'path',
      from: { filePath: 'src/api/AuthController.ts', symbolName: 'AuthController' },
      to: { filePath: 'src/data/DatabasePool.ts', symbolName: 'DatabasePool' },
      directed: true,
      depth: 5,
    });

    expect(response.paths).toEqual([{
      nodeIds: [
        IDS.authController,
        IDS.authenticate,
        IDS.tokenVerifier,
        IDS.userRepository,
        IDS.databasePool,
      ],
      edgeIndexes: [0, 1, 2, 3],
      hops: 4,
    }]);
    expect(response.paths[0].edgeIndexes.map(index => response.edges[index].relation)).toEqual([
      'CALLS',
      'CALLS',
      'CALLS',
      'USES',
    ]);
  });

  it('returns a deterministic high-degree fallback for overview questions', async () => {
    const response = await retriever.retrieve({
      question: 'Give me an overview of the authentication graph',
      mode: 'overview',
      maxNodes: 5,
    });

    expect(response.seeds[0]?.id).toBe(IDS.authenticate);
    expect(response.nodes[0]?.id).toBe(IDS.authenticate);
    expect(response.edges.map(result => result.relation)).toEqual(expect.arrayContaining([
      'CALLS',
      'IMPLEMENTS',
    ]));
    expect(response.omitted.nodes).toBeGreaterThan(0);
    expect(response.nextQueries[0]).toContain('authenticate');
  });

  it('suggests concrete paths instead of choosing an ambiguous deterministic seed', async () => {
    const response = await retriever.retrieve({
      question: 'Inspect AuthGateway neighbors',
      mode: 'neighbors',
      seeds: [{ symbolName: 'AuthGateway' }],
    });

    expect(response.seeds).toEqual([]);
    expect(response.ambiguous.map(candidate => candidate.node.id)).toEqual([
      IDS.adminAuthGateway,
      IDS.authGateway,
    ]);
    expect(response.nextQueries).toEqual(expect.arrayContaining([
      'Disambiguate AuthGateway at src/admin/AuthGateway.ts',
      'Disambiguate AuthGateway at src/auth/AuthGateway.ts',
    ]));
  });

  it('caps locally ranked search seeds at twenty', async () => {
    const manyNodes = Array.from({ length: 25 }, (_, index) => node(
      `symbol:src/ranked/rankedSeed${index}.ts:rankedSeed${index}:1`,
      'symbol',
      `rankedSeed${index}`,
      `src/ranked/rankedSeed${index}.ts`,
      1,
    ));
    for (const graphNode of manyNodes) {
      db.run(
        `INSERT INTO nodes (id, name, type, path, folder, start_line)
         VALUES (?, ?, 'symbol', ?, 'src/ranked', 1)`,
        [`raw:${graphNode.id}`, graphNode.name, `${WORKSPACE_ROOT}/${graphNode.path}`],
      );
    }
    const cappedRetriever = new GraphContextRetriever({
      snapshotProvider: {
        buildSnapshot: async (_request: GraphContextRequest) => ({
          revision: 'many-seeds',
          fresh: true,
          nodes: manyNodes,
          edges: [],
        }),
      },
      queryEngine: new QueryEngine(db, null),
      workspaceRoot: WORKSPACE_ROOT,
    });

    const constrainedResponse = await cappedRetriever.retrieve({
      question: 'rankedSeed',
      mode: 'search',
      maxNodes: 3,
    });
    const mixedResponse = await cappedRetriever.retrieve({
      question: 'rankedSeed',
      mode: 'search',
      seeds: [{ id: manyNodes[0].id }],
      maxNodes: 3,
    });
    const cappedResponse = await cappedRetriever.retrieve({
      question: 'rankedSeed',
      mode: 'search',
      maxNodes: 100,
    });

    expect(constrainedResponse.seeds).toHaveLength(3);
    expect(constrainedResponse.nodes).toHaveLength(3);
    expect(mixedResponse.seeds).toHaveLength(3);
    expect(mixedResponse.seeds[0]?.id).toBe(manyNodes[0].id);
    expect(cappedResponse.seeds).toHaveLength(20);
  });

  it('preserves every explicit seed beyond the generated search seed cap', async () => {
    const requestedNodes = Array.from({ length: 22 }, (_, index) => node(
      `file:src/requested/Requested${index}.ts`,
      'file',
      `Requested${index}.ts`,
      `src/requested/Requested${index}.ts`,
    ));
    const requestedRetriever = new GraphContextRetriever({
      snapshotProvider: {
        buildSnapshot: async () => ({
          revision: 'explicit-seeds',
          fresh: true,
          nodes: requestedNodes,
          edges: [],
        }),
      },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await requestedRetriever.retrieve({
      question: 'Preserve all requested entities',
      mode: 'search',
      seeds: requestedNodes.map(requestedNode => ({ id: requestedNode.id })),
      maxNodes: 5,
    });

    expect(response.seeds.map(seed => seed.id)).toEqual(requestedNodes.map(requestedNode => requestedNode.id));
    expect(response.nodes).toHaveLength(requestedNodes.length);
    expect(response.nodes.map(result => result.id)).toEqual(expect.arrayContaining(
      requestedNodes.map(requestedNode => requestedNode.id),
    ));
  });

  it('keeps traversal connectors when maxNodes excludes deeper higher-scored nodes', async () => {
    const rootId = 'symbol:src/root/RootGateway.ts:RootGateway:1';
    const connectorId = 'symbol:src/bridge/Bridge.ts:Bridge:1';
    const implementationId = 'symbol:src/impl/BridgeImplementation.ts:BridgeImplementation:1';
    const connectedSnapshot: GraphContextSnapshot = {
      revision: 'connected-frontier',
      fresh: true,
      nodes: [
        node(rootId, 'symbol', 'RootGateway', 'src/root/RootGateway.ts', 1),
        node(connectorId, 'symbol', 'Bridge', 'src/bridge/Bridge.ts', 1),
        node(implementationId, 'symbol', 'BridgeImplementation', 'src/impl/BridgeImplementation.ts', 1),
      ],
      edges: [
        edge(connectorId, rootId, 'CONTAINS'),
        edge(implementationId, connectorId, 'IMPLEMENTS'),
      ],
    };
    const connectedRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => connectedSnapshot },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await connectedRetriever.retrieve({
      question: 'What changes when I refactor RootGateway?',
      mode: 'refactor',
      seeds: [{ id: rootId }],
      depth: 2,
      maxNodes: 2,
    });

    expect(response.nodes.map(result => result.id)).toEqual([rootId, connectorId]);
    expect(response.edges).toEqual([
      expect.objectContaining({ source: connectorId, target: rootId, relation: 'CONTAINS' }),
    ]);
  });

  it('orders direct impact dependents ahead of transitive higher-scored dependents', async () => {
    const rootId = 'symbol:src/root/Root.ts:Root:1';
    const directId = 'symbol:src/direct/Direct.ts:Direct:1';
    const transitiveId = 'symbol:src/transitive/Transitive.ts:Transitive:1';
    const impactSnapshot: GraphContextSnapshot = {
      revision: 'impact-frontier-order',
      fresh: true,
      nodes: [
        node(rootId, 'symbol', 'Root', 'src/root/Root.ts', 1),
        node(directId, 'symbol', 'Direct', 'src/direct/Direct.ts', 1),
        node(transitiveId, 'symbol', 'Transitive', 'src/transitive/Transitive.ts', 1),
      ],
      edges: [
        edge(directId, rootId, 'REFERENCES'),
        edge(transitiveId, directId, 'CALLS'),
      ],
    };
    const impactRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => impactSnapshot },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await impactRetriever.retrieve({
      question: 'Which callers are impacted?',
      mode: 'impact',
      seeds: [{ id: rootId }],
      depth: 2,
      maxNodes: 3,
    });

    expect(response.nodes.map(result => result.id)).toEqual([rootId, directId, transitiveId]);
  });

  it('uses inferred dependent edges for follow-up suggestions', async () => {
    const serviceId = 'file:src/orders/OrderService.ts';
    const apiId = 'file:src/api/OrderApi.ts';
    const suggestionSnapshot: GraphContextSnapshot = {
      revision: 'inferred-suggestion',
      fresh: true,
      nodes: [
        node(serviceId, 'file', 'OrderService.ts', 'src/orders/OrderService.ts'),
        node(apiId, 'file', 'OrderApi.ts', 'src/api/OrderApi.ts'),
      ],
      edges: [],
    };
    const suggestionRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => suggestionSnapshot },
      dependentsProvider: {
        findReferencingFiles: async () => [{ path: `${WORKSPACE_ROOT}/src/api/OrderApi.ts` }],
        getSymbolDependents: async () => [],
      },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await suggestionRetriever.retrieve({
      question: 'What depends on the OrderService file?',
      mode: 'impact',
      maxNodes: 1,
    });

    expect(response.edges).toEqual([]);
    expect(response.nextQueries).toContain(
      'Explore IMPACTED_BY around OrderService.ts in src/orders/OrderService.ts',
    );
  });

  it('exposes provenance for inferred dependent edges', async () => {
    const serviceId = 'file:src/orders/OrderService.ts';
    const apiId = 'file:src/api/OrderApi.ts';
    const inferredSnapshot: GraphContextSnapshot = {
      revision: 'inferred-edge',
      fresh: true,
      nodes: [
        node(serviceId, 'file', 'OrderService.ts', 'src/orders/OrderService.ts'),
        node(apiId, 'file', 'OrderApi.ts', 'src/api/OrderApi.ts'),
      ],
      edges: [],
    };
    const inferredRetriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => inferredSnapshot },
      dependentsProvider: {
        findReferencingFiles: async () => [{ path: `${WORKSPACE_ROOT}/src/api/OrderApi.ts` }],
        getSymbolDependents: async () => [],
      },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await inferredRetriever.retrieve({
      question: 'Which files depend on OrderService?',
      mode: 'impact',
      seeds: [{ id: serviceId }],
      depth: 1,
      maxNodes: 2,
    });

    expect(response.edges).toContainEqual(expect.objectContaining({
      source: apiId,
      target: serviceId,
      relation: 'IMPACTED_BY',
      confidence: 'INFERRED',
      evidence: {
        sourcePath: 'src/api/OrderApi.ts',
        reason: 'IMPACTED_BY relation inferred from graph analysis.',
      },
    }));
  });
});

describe('GraphContextScorer relation intent', () => {
  const scorer = new GraphContextScorer({ workspaceRoot: WORKSPACE_ROOT });
  const target = node('symbol:src/example.ts:target:1', 'symbol', 'target', 'src/example.ts', 1);

  it.each(['calls', 'callers'])('boosts CALLS for the %s word form', word => {
    expect(scorer.scoreRelation('search', 'CALLS', `Which ${word} reach target?`, target)).toBe(130);
  });

  it('boosts dependency relations for the dependencies word form', () => {
    expect(scorer.scoreRelation('impact', 'IMPORTS', 'Which dependencies change?', target)).toBe(105);
  });

  it('boosts implementation relations for the implementations word form', () => {
    expect(scorer.scoreRelation('refactor', 'IMPLEMENTS', 'Which implementations change?', target)).toBe(155);
  });
});
