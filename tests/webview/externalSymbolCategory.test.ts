import { describe, expect, it } from 'vitest';
import { buildReactFlowGraph } from '../../src/webview/components/reactflow/buildGraph';

describe('External Symbol Category Inference', () => {
  it('should infer "method" category for external symbols with dot notation', () => {
    const data = {
      nodes: ['current.ts:myFunction', 'external.ts:service.getToken'],
      edges: [
        {
          source: 'current.ts:myFunction',
          target: 'external.ts:service.getToken',
        },
      ],
      nodeLabels: {
        'current.ts:myFunction': 'myFunction',
        'external.ts:service.getToken': 'service.getToken',
      },
    };

    const symbolData = {
      symbols: [
        {
          id: 'current.ts:myFunction',
          name: 'myFunction',
          kind: 'Function',
          category: 'function' as const,
          line: 5,
          isExported: true,
        },
      ],
      dependencies: [],
    };

    const result = buildReactFlowGraph({
      data,
      mode: 'symbol',
      symbolData,
      currentFilePath: 'current.ts:myFunction', // Use symbol ID as root
      expandAll: true,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: {
        onToggle: () => {},
        onDrillDown: () => {},
        onExpandRequest: () => {},
        onFindReferences: () => {},
      },
    });

    const externalNode = result.nodes.find(
      (n) => n.id === 'external.ts:service.getToken',
    );
    expect(externalNode).toBeDefined();
    expect('category' in externalNode!.data).toBe(true);
    expect((externalNode!.data as any).category).toBe('method');
  });

  it('should infer "class" category for external symbols starting with uppercase', () => {
    const data = {
      nodes: ['current.ts:myFunction', 'external.ts:UserService'],
      edges: [
        {
          source: 'current.ts:myFunction',
          target: 'external.ts:UserService',
        },
      ],
      nodeLabels: {
        'current.ts:myFunction': 'myFunction',
        'external.ts:UserService': 'UserService',
      },
    };

    const symbolData = {
      symbols: [
        {
          id: 'current.ts:myFunction',
          name: 'myFunction',
          kind: 'Function',
          category: 'function' as const,
          line: 5,
          isExported: true,
        },
      ],
      dependencies: [],
    };

    const result = buildReactFlowGraph({
      data,
      mode: 'symbol',
      symbolData,
      currentFilePath: 'current.ts:myFunction',
      expandAll: true,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: {
        onToggle: () => {},
        onDrillDown: () => {},
        onExpandRequest: () => {},
        onFindReferences: () => {},
      },
    });

    const externalNode = result.nodes.find(
      (n) => n.id === 'external.ts:UserService',
    );
    expect(externalNode).toBeDefined();
    expect('category' in externalNode!.data).toBe(true);
    expect((externalNode!.data as any).category).toBe('class');
  });

  it('should infer "function" category as default for other external symbols', () => {
    const data = {
      nodes: ['current.ts:myFunction', 'external.ts:helper'],
      edges: [
        {
          source: 'current.ts:myFunction',
          target: 'external.ts:helper',
        },
      ],
      nodeLabels: {
        'current.ts:myFunction': 'myFunction',
        'external.ts:helper': 'helper',
      },
    };

    const symbolData = {
      symbols: [
        {
          id: 'current.ts:myFunction',
          name: 'myFunction',
          kind: 'Function',
          category: 'function' as const,
          line: 5,
          isExported: true,
        },
      ],
      dependencies: [],
    };

    const result = buildReactFlowGraph({
      data,
      mode: 'symbol',
      symbolData,
      currentFilePath: 'current.ts:myFunction',
      expandAll: true,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: {
        onToggle: () => {},
        onDrillDown: () => {},
        onExpandRequest: () => {},
        onFindReferences: () => {},
      },
    });

    const externalNode = result.nodes.find((n) => n.id === 'external.ts:helper');
    expect(externalNode).toBeDefined();
    expect('category' in externalNode!.data).toBe(true);
    expect((externalNode!.data as any).category).toBe('function');
  });

  it('should display inferred icon, not "?" for external symbols', () => {
    const data = {
      nodes: ['current.ts:myFunction', 'external.ts:unknownSymbol'],
      edges: [
        {
          source: 'current.ts:myFunction',
          target: 'external.ts:unknownSymbol',
        },
      ],
      nodeLabels: {
        'current.ts:myFunction': 'myFunction',
        'external.ts:unknownSymbol': 'unknownSymbol',
      },
    };

    const symbolData = {
      symbols: [
        {
          id: 'current.ts:myFunction',
          name: 'myFunction',
          kind: 'Function',
          category: 'function' as const,
          line: 5,
          isExported: true,
        },
      ],
      dependencies: [],
    };

    const result = buildReactFlowGraph({
      data,
      mode: 'symbol',
      symbolData,
      currentFilePath: 'current.ts:myFunction',
      expandAll: true,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: {
        onToggle: () => {},
        onDrillDown: () => {},
        onExpandRequest: () => {},
        onFindReferences: () => {},
      },
    });

    const externalNode = result.nodes.find(
      (n) => n.id === 'external.ts:unknownSymbol',
    );
    expect(externalNode).toBeDefined();
    // Should have inferred category (function), not fall back to 'other'
    expect('category' in externalNode!.data).toBe(true);
    const category = (externalNode!.data as any).category;
    expect(category).toBe('function');
    expect(category).not.toBe('other');
  });
});
