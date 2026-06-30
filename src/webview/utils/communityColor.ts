import { COMMUNITY_PALETTE } from '../../shared/communityPalette';

/**
 * Returns hex color for a community id.
 * communityId 0 (isolated) → transparent.
 * communityId 1+ → COMMUNITY_PALETTE cyclic.
 * absent → transparent.
 */
export function communityColor(communityId: number | undefined): string {
  if (communityId === undefined || communityId === 0) return 'transparent';
  return COMMUNITY_PALETTE[(communityId - 1) % COMMUNITY_PALETTE.length];
}
