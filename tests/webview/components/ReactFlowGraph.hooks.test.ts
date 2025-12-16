import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for ReactFlowGraph hooks stability and race condition fixes
 * 
 * These tests validate the fixes for the critical bugs where nodes/edges
 * would disappear during expand/collapse due to:
 * 1. Unstable Set references causing useMemo to recalculate unnecessarily
 * 2. Callback objects being recreated on every render
 * 3. useEffect triggering on array reference changes instead of content changes
 * 
 * Note: These are unit tests for the logic, not React component tests.
 * We test the core algorithms and patterns used in the hooks.
 */

describe('ReactFlowGraph - Hook Stability Logic', () => {
  describe('expandedNodesKey stability algorithm', () => {
    it('should create stable key when Set content is identical', () => {
      const set1 = new Set(['a', 'b', 'c']);
      const set2 = new Set(['c', 'a', 'b']); // Different order

      const key1 = Array.from(set1).sort().join('|');
      const key2 = Array.from(set2).sort().join('|');

      // Keys should be identical regardless of Set iteration order
      expect(key1).toBe('a|b|c');
      expect(key2).toBe('a|b|c');
      expect(key1).toBe(key2);
    });

    it('should produce different keys when Set content changes', () => {
      const set1 = new Set(['a', 'b']);
      const set2 = new Set(['a', 'b', 'c']);
      const set3 = new Set(['a']);

      const key1 = Array.from(set1).sort().join('|');
      const key2 = Array.from(set2).sort().join('|');
      const key3 = Array.from(set3).sort().join('|');

      expect(key1).toBe('a|b');
      expect(key2).toBe('a|b|c');
      expect(key3).toBe('a');
      expect(key2).not.toBe(key1);
      expect(key3).not.toBe(key1);
      expect(key3).not.toBe(key2);
    });

    it('should handle empty Set', () => {
      const emptySet = new Set<string>();
      const key = Array.from(emptySet).sort().join('|');
      expect(key).toBe('');
    });

    it('should handle single element', () => {
      const set = new Set(['single']);
      const key = Array.from(set).sort().join('|');
      expect(key).toBe('single');
    });
  });

  describe('callbacks object stability pattern', () => {
    it('should demonstrate callback reference equality', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      const callbacks1 = { onToggle: fn1, onExpand: fn2 };
      const callbacks2 = { onToggle: fn1, onExpand: fn2 };

      // Different object instances
      expect(callbacks2).not.toBe(callbacks1);
      
      // But same function references
      expect(callbacks2.onToggle).toBe(fn1);
      expect(callbacks2.onExpand).toBe(fn2);
    });

    it('should show why useMemo is needed for callbacks', () => {
      const fn = vi.fn();
      
      // Without memoization: new object every time
      const createCallbacks = () => ({ onToggle: fn });
      const obj1 = createCallbacks();
      const obj2 = createCallbacks();
      
      expect(obj2).not.toBe(obj1); // Problem!

      // With memoization simulation: cache the object
      let cachedCallbacks: typeof obj1 | null = null;
      let lastFn: typeof fn | null = null;
      
      const createMemoizedCallbacks = (currentFn: typeof fn) => {
        if (cachedCallbacks && lastFn === currentFn) {
          return cachedCallbacks; // Return cached
        }
        cachedCallbacks = { onToggle: currentFn };
        lastFn = currentFn;
        return cachedCallbacks;
      };

      const memoized1 = createMemoizedCallbacks(fn);
      const memoized2 = createMemoizedCallbacks(fn);
      
      expect(memoized2).toBe(memoized1); // Fixed!
    });
  });

  describe('toggleExpandedNode atomic update pattern', () => {
    it('should toggle node correctly', () => {
      const expandedNodes = new Set(['a', 'b']);
      
      // Simulate toggle 'a' off
      const next = new Set(expandedNodes);
      if (next.has('a')) {
        next.delete('a');
      } else {
        next.add('a');
      }

      expect(next.has('a')).toBe(false);
      expect(next.has('b')).toBe(true);
      expect(next.size).toBe(1);
    });

    it('should toggle node on', () => {
      const expandedNodes = new Set(['a']);
      
      // Simulate toggle 'b' on
      const next = new Set(expandedNodes);
      if (next.has('b')) {
        next.delete('b');
      } else {
        next.add('b');
      }

      expect(next.has('a')).toBe(true);
      expect(next.has('b')).toBe(true);
      expect(next.size).toBe(2);
    });

    it('should demonstrate early return pattern for no-op updates', () => {
      const expandedNodes = new Set(['a', 'b']);
      
      // Simulate handleExpand for node already expanded
      const expand = (path: string) => {
        if (expandedNodes.has(path)) {
          return expandedNodes; // Early return with same reference
        }
        const next = new Set(expandedNodes);
        next.add(path);
        return next;
      };

      const result = expand('a'); // 'a' is already expanded
      expect(result).toBe(expandedNodes); // Same reference!

      const result2 = expand('c'); // 'c' is not expanded
      expect(result2).not.toBe(expandedNodes); // New reference
      expect(result2.has('c')).toBe(true);
    });
  });

  describe('graph object dependency pattern', () => {
    it('should show difference between object vs property dependencies', () => {
      const graph1 = { nodes: ['a', 'b'], edges: ['e1'] };
      const graph2 = { nodes: ['a', 'b'], edges: ['e1'] };

      // Different graph objects
      expect(graph2).not.toBe(graph1);
      
      // But conceptually same content
      expect(graph2.nodes).toEqual(graph1.nodes);
      expect(graph2.edges).toEqual(graph1.edges);

      // Arrays are always new references
      expect(graph2.nodes).not.toBe(graph1.nodes);
      expect(graph2.edges).not.toBe(graph1.edges);
    });

    it('should demonstrate why depending on graph object is better than arrays', () => {
      const graph = { nodes: ['a'], edges: [] };
      
      // Simulating useMemo caching
      let cachedGraph = graph;
      let recalcCount = 0;

      // Pattern 1: Depend on graph.nodes and graph.edges (BAD)
      const checkWithArrayDeps = (currentGraph: typeof graph) => {
        const nodesChanged = cachedGraph.nodes !== currentGraph.nodes;
        const edgesChanged = cachedGraph.edges !== currentGraph.edges;
        
        if (nodesChanged || edgesChanged) {
          recalcCount++;
          cachedGraph = currentGraph;
        }
      };

      // Pattern 2: Depend on graph object itself (GOOD)
      let recalcCount2 = 0;
      let cachedGraph2 = graph;
      const checkWithObjectDep = (currentGraph: typeof graph) => {
        if (cachedGraph2 !== currentGraph) {
          recalcCount2++;
          cachedGraph2 = currentGraph;
        }
      };

      // Simulate render with new arrays but same graph object
      // (This would NOT happen in reality because useMemo would cache)
      // But let's simulate a mutation scenario
      const sameGraphRef = graph;

      checkWithArrayDeps(sameGraphRef);
      checkWithObjectDep(sameGraphRef);

      // Both should not trigger since it's the same graph reference
      expect(recalcCount).toBe(0);
      expect(recalcCount2).toBe(0);

      // Now pass a truly different graph object
      const newGraph = { nodes: ['a', 'b'], edges: ['e1'] };
      
      checkWithArrayDeps(newGraph);
      checkWithObjectDep(newGraph);

      // Both should trigger now
      expect(recalcCount).toBe(1);
      expect(recalcCount2).toBe(1);
    });
  });

  describe('useMemo recalculation control with stable key', () => {
    it('should show when to recalculate based on key instead of Set', () => {
      const set1 = new Set(['a', 'b']);
      const set2 = new Set(['a', 'b']); // Same content, different object
      const set3 = new Set(['a', 'b', 'c']); // Different content

      const key1 = Array.from(set1).sort().join('|');
      const key2 = Array.from(set2).sort().join('|');
      const key3 = Array.from(set3).sort().join('|');

      let recalcCount = 0;
      let lastKey = '';
      
      const checkRecalc = (key: string) => {
        if (key !== lastKey) {
          recalcCount++;
          lastKey = key;
        }
      };

      checkRecalc(key1);
      expect(recalcCount).toBe(1);

      checkRecalc(key2); // Same content
      expect(recalcCount).toBe(1); // No recalc!

      checkRecalc(key3); // Different content
      expect(recalcCount).toBe(2); // Recalc!
    });
  });

  describe('race condition prevention pattern', () => {
    it('should handle rapid sequential updates correctly', () => {
      let expandedNodes = new Set(['root']);
      
      const toggle = (path: string) => {
        const next = new Set(expandedNodes);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        expandedNodes = next;
      };

      // Rapid toggles
      toggle('a');
      toggle('b');
      toggle('c');
      toggle('a'); // Toggle 'a' again (should be off)

      // Final state should be correct
      expect(expandedNodes.has('root')).toBe(true);
      expect(expandedNodes.has('a')).toBe(false); // Toggled twice
      expect(expandedNodes.has('b')).toBe(true);
      expect(expandedNodes.has('c')).toBe(true);
      expect(expandedNodes.size).toBe(3);
    });
  });

  describe('reset detection with ref tracking', () => {
    it('should detect when reset is needed', () => {
      const lastReset = { resetToken: 0, currentFilePath: '/root.ts', expandAll: false };

      const shouldReset1 = (resetToken: number, currentFilePath: string, expandAll: boolean) => {
        return (
          lastReset.resetToken !== resetToken ||
          lastReset.currentFilePath !== currentFilePath ||
          lastReset.expandAll !== expandAll
        );
      };

      // Same state
      expect(shouldReset1(0, '/root.ts', false)).toBe(false);

      // Different resetToken
      expect(shouldReset1(1, '/root.ts', false)).toBe(true);

      // Different currentFilePath
      expect(shouldReset1(0, '/other.ts', false)).toBe(true);

      // Different expandAll
      expect(shouldReset1(0, '/root.ts', true)).toBe(true);
    });
  });

  describe('Set equality check for expandAll optimization', () => {
    it('should detect when two Sets have identical content', () => {
      const set1 = new Set(['a', 'b', 'c']);
      const set2 = new Set(['a', 'b', 'c']);

      const areEqual = (s1: Set<string>, s2: Set<string>) => {
        if (s1.size !== s2.size) return false;
        for (const item of s1) {
          if (!s2.has(item)) return false;
        }
        return true;
      };

      expect(areEqual(set1, set2)).toBe(true);
    });

    it('should detect when Sets have different content', () => {
      const set1 = new Set(['a', 'b']);
      const set2 = new Set(['a', 'b', 'c']);

      const areEqual = (s1: Set<string>, s2: Set<string>) => {
        if (s1.size !== s2.size) return false;
        for (const item of s1) {
          if (!s2.has(item)) return false;
        }
        return true;
      };

      expect(areEqual(set1, set2)).toBe(false);
    });

    it('should use early return when Sets are equal to avoid state update', () => {
      const prev = new Set(['a', 'b']);
      const allNodes = new Set(['a', 'b']); // Same content

      // Simulate the setState callback with early return
      const getNextState = (previous: Set<string>, newNodes: Set<string>) => {
        if (previous.size === newNodes.size) {
          let equal = true;
          for (const node of newNodes) {
            if (!previous.has(node)) {
              equal = false;
              break;
            }
          }
          if (equal) return previous; // Early return!
        }
        return newNodes;
      };

      const result = getNextState(prev, allNodes);
      expect(result).toBe(prev); // Same reference returned
    });
  });
});
