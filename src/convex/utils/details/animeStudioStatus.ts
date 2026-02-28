import type { QueryCtx } from '../../_generated/server';
import type { AnimeStudioStatus, HeaderContributorInput } from '../../types/detailsType';

import { hasAniListStudioCredits, hasManualStudioCredits } from './headerContext';

function animeSeasonSyncKey(tmdbType: 'movie' | 'tv', tmdbId: number): string {
	return `season:${tmdbType}:${tmdbId}`;
}

export async function resolveAnimeStudioStatus(
	ctx: QueryCtx,
	tmdbType: 'movie' | 'tv',
	tmdbId: number,
	creatorCredits: HeaderContributorInput[] | null | undefined,
	isAnime: boolean
): Promise<AnimeStudioStatus> {
	if (!isAnime) return 'not_applicable';
	if (hasManualStudioCredits(creatorCredits)) return 'resolved';
	if (hasAniListStudioCredits(creatorCredits)) return 'resolved';

	const queueRow = await ctx.db
		.query('animeSyncQueue')
		.withIndex('by_syncKey', (q) => q.eq('syncKey', animeSeasonSyncKey(tmdbType, tmdbId)))
		.unique();

	if (!queueRow) return 'pending';
	if (queueRow.state === 'queued' || queueRow.state === 'running' || queueRow.state === 'retry') {
		return 'pending';
	}
	if (queueRow.lastSuccessAt != null) return 'unavailable';
	if (queueRow.state === 'error') return 'unavailable';
	return 'pending';
}
