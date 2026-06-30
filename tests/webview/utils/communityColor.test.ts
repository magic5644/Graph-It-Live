import { describe, expect, it } from 'vitest';
import { COMMUNITY_PALETTE } from '../../../src/shared/communityPalette';
import { communityColor } from '../../../src/webview/utils/communityColor';

describe('communityColor', () => {
  it('returns transparent for undefined', () => {
    expect(communityColor(undefined)).toBe('transparent');
  });

  it('returns transparent for communityId 0 (isolated)', () => {
    expect(communityColor(0)).toBe('transparent');
  });

  it('returns COMMUNITY_PALETTE[0] for communityId 1', () => {
    expect(communityColor(1)).toBe(COMMUNITY_PALETTE[0]);
  });

  it('returns COMMUNITY_PALETTE[11] for communityId 12', () => {
    expect(communityColor(12)).toBe(COMMUNITY_PALETTE[11]);
  });

  it('cycles back to COMMUNITY_PALETTE[0] for communityId 13', () => {
    expect(communityColor(13)).toBe(COMMUNITY_PALETTE[0]);
  });

  it('cycles correctly for communityId 25 (2 full cycles + 1)', () => {
    expect(communityColor(25)).toBe(COMMUNITY_PALETTE[0]);
  });
});
