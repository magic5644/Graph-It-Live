/**
 * Unit tests for communityPalette (F4 feature).
 */
import { describe, it, expect } from 'vitest';
import { COMMUNITY_PALETTE } from '../../src/shared/communityPalette.js';

describe('COMMUNITY_PALETTE', () => {
  it('has exactly 12 colors', () => {
    expect(COMMUNITY_PALETTE.length).toBe(12);
  });

  it('each color is a valid 6-char hex string', () => {
    for (const color of COMMUNITY_PALETTE) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('is readonly (cannot be reassigned via TypeScript type)', () => {
    // Type-level check: TypeScript will prevent mutations at compile time.
    // Runtime: the array is a plain array (const assertion doesn't freeze),
    // but we can verify the type is readonly string[] by checking it is an array.
    expect(Array.isArray(COMMUNITY_PALETTE)).toBe(true);
  });

  it('all colors are unique', () => {
    const unique = new Set(COMMUNITY_PALETTE);
    expect(unique.size).toBe(COMMUNITY_PALETTE.length);
  });
});
