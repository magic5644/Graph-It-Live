import { describe, expect, it } from 'vitest';
import { GraphContextCommunities } from '../../../src/analyzer/graph-context/GraphContextCommunities';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextSnapshot,
} from '../../../src/shared/graph-context-types';

const nodes: GraphContextNode[] = [
  { id: 'symbol:a', kind: 'symbol', name: 'a' },
  { id: 'symbol:b', kind: 'symbol', name: 'b' },
  { id: 'symbol:c', kind: 'symbol', name: 'c' },
  { id: 'symbol:d', kind: 'symbol', name: 'd' },
  { id: 'symbol:e', kind: 'symbol', name: 'e' },
  { id: 'symbol:f', kind: 'symbol', name: 'f' },
  { id: 'file:isolated', kind: 'file', name: 'isolated' },
];

const edges: GraphContextEdge[] = [
  { source: 'symbol:a', target: 'symbol:b', relation: 'CALLS', confidence: 'EXTRACTED' },
  { source: 'symbol:b', target: 'symbol:c', relation: 'CALLS', confidence: 'EXTRACTED' },
  { source: 'symbol:c', target: 'symbol:a', relation: 'CALLS', confidence: 'RESOLVED' },
  { source: 'symbol:c', target: 'symbol:d', relation: 'USES', confidence: 'INFERRED' },
  { source: 'symbol:d', target: 'symbol:e', relation: 'CALLS', confidence: 'EXTRACTED' },
  { source: 'symbol:e', target: 'symbol:f', relation: 'CALLS', confidence: 'STALE' },
  { source: 'symbol:f', target: 'symbol:d', relation: 'CALLS', confidence: 'AMBIGUOUS' },
];

const snapshot = (reverse = false): GraphContextSnapshot => ({
  revision: 'topology-v1',
  fresh: true,
  nodes: reverse ? [...nodes].reverse() : nodes,
  edges: reverse ? [...edges].reverse() : edges,
});

describe('GraphContextCommunities', () => {
  it('derives deterministic communities, hubs, and graph statistics', () => {
    const topology = new GraphContextCommunities(snapshot());
    const reversed = new GraphContextCommunities(snapshot(true));

    expect(topology.getCommunity(1)?.nodes.map(node => node.id)).toEqual([
      'symbol:a',
      'symbol:b',
      'symbol:c',
    ]);
    expect(topology.getCommunity(2)?.nodes.map(node => node.id)).toEqual([
      'symbol:d',
      'symbol:e',
      'symbol:f',
    ]);
    expect(topology.getCommunity(0)?.nodes.map(node => node.id)).toEqual(['file:isolated']);
    expect(reversed.getCommunity(1)).toEqual(topology.getCommunity(1));
    expect(reversed.getCommunity(2)).toEqual(topology.getCommunity(2));

    expect(topology.topHubs(2)).toEqual([
      {
        node: nodes[2],
        communityId: 1,
        inDegree: 1,
        outDegree: 2,
        totalDegree: 3,
      },
      {
        node: nodes[3],
        communityId: 2,
        inDegree: 2,
        outDegree: 1,
        totalDegree: 3,
      },
    ]);
    expect(topology.graphStats).toEqual({
      nodeCount: 7,
      edgeCount: 7,
      communityCount: 2,
      relationCounts: { CALLS: 6, USES: 1 },
      nodeKindCounts: { file: 1, symbol: 6 },
      confidenceCounts: {
        AMBIGUOUS: 1,
        EXTRACTED: 3,
        INFERRED: 1,
        RESOLVED: 1,
        STALE: 1,
      },
    });
  });

  it('excludes unresolved external nodes from hubs unless requested', () => {
    const external: GraphContextNode = { id: 'external:framework', kind: 'external', name: 'framework' };
    const topology = new GraphContextCommunities({
      ...snapshot(),
      nodes: [...nodes, external],
      edges: [
        ...edges,
        { source: external.id, target: 'symbol:a', relation: 'CALLS', confidence: 'AMBIGUOUS' },
        { source: external.id, target: 'symbol:b', relation: 'CALLS', confidence: 'AMBIGUOUS' },
        { source: external.id, target: 'symbol:c', relation: 'CALLS', confidence: 'AMBIGUOUS' },
        { source: external.id, target: 'symbol:d', relation: 'CALLS', confidence: 'AMBIGUOUS' },
      ],
    });

    expect(topology.topHubs(1)[0]?.node.id).toBe('symbol:c');
    expect(topology.topHubs(1, true)[0]?.node.id).toBe(external.id);
  });

  it('keeps a loop-only node out of the isolated community', () => {
    const isolated: GraphContextNode = { id: 'file:isolated', kind: 'file', name: 'isolated' };
    const looped: GraphContextNode = { id: 'symbol:looped', kind: 'symbol', name: 'looped' };
    const loop: GraphContextEdge = {
      source: looped.id,
      target: looped.id,
      relation: 'CALLS',
      confidence: 'EXTRACTED',
    };
    const topology = new GraphContextCommunities({
      revision: 'self-loop-v1',
      fresh: true,
      nodes: [looped, isolated],
      edges: [loop],
    });

    expect(topology.getCommunity(0)?.nodes).toEqual([isolated]);
    expect(topology.getCommunity(1)).toEqual({ id: 1, nodes: [looped], edges: [loop] });
    expect(topology.topHubs(1)).toEqual([{
      node: looped,
      communityId: 1,
      inDegree: 1,
      outDegree: 1,
      totalDegree: 2,
    }]);
    expect(topology.graphStats).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      communityCount: 1,
      relationCounts: { CALLS: 1 },
      nodeKindCounts: { file: 1, symbol: 1 },
      confidenceCounts: { EXTRACTED: 1 },
    });
  });

  it('keeps loop edges deterministic inside a connected community', () => {
    const connectedNodes: GraphContextNode[] = [
      { id: 'symbol:a', kind: 'symbol', name: 'a' },
      { id: 'symbol:b', kind: 'symbol', name: 'b' },
    ];
    const connectedEdges: GraphContextEdge[] = [
      { source: 'symbol:a', target: 'symbol:a', relation: 'CALLS', confidence: 'EXTRACTED' },
      { source: 'symbol:a', target: 'symbol:b', relation: 'USES', confidence: 'RESOLVED' },
    ];
    const topology = new GraphContextCommunities({
      revision: 'self-loop-connected-v1',
      fresh: true,
      nodes: connectedNodes,
      edges: connectedEdges,
    });
    const reversed = new GraphContextCommunities({
      revision: 'self-loop-connected-v1',
      fresh: true,
      nodes: [...connectedNodes].reverse(),
      edges: [...connectedEdges].reverse(),
    });

    expect(topology.getCommunity(1)).toEqual({
      id: 1,
      nodes: connectedNodes,
      edges: connectedEdges,
    });
    expect(reversed.getCommunity(1)).toEqual(topology.getCommunity(1));
    expect(reversed.graphStats).toEqual(topology.graphStats);
  });
});
