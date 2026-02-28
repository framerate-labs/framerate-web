import type { DisplaySeasonStatus } from '../../types/animeEpisodeTypes';

import { v } from 'convex/values';

export const tmdbTypeValidator = v.union(v.literal('movie'), v.literal('tv'));

export function resolveDisplayPlanMode(
	titleOverride?: {
		displayPlanMode?: 'auto' | 'custom' | null;
	} | null
): 'auto' | 'custom' {
	return titleOverride?.displayPlanMode === 'custom' ? 'custom' : 'auto';
}

export function isSoftClosedLikeStatus(status: DisplaySeasonStatus | undefined): boolean {
	return status === 'soft_closed' || status === 'auto_soft_closed';
}
