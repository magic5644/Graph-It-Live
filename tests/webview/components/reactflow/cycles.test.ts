import { describe, expect, it } from 'vitest';
import { detectCycles } from '../../../../src/webview/components/reactflow/cycles';

describe('detectCycles', () => {
  it('returns nodes involved in a cycle', () => {
    const cycles = detectCycles([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
      { source: 'x', target: 'y' },
    ]);
    expect(cycles.has('a')).toBe(true);
    expect(cycles.has('b')).toBe(true);
    expect(cycles.has('c')).toBe(true);
    expect(cycles.has('x')).toBe(false);
  });
});

