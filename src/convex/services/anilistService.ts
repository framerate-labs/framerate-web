import type { AniListRateLimitHints, AniListRequestMetrics } from '../types/anilistTypes';
import type { AniListMediaCore } from '../types/animeTypes';

import { anilistGraphQL } from '../utils/anime/client';
import {
	createAniListRequestMetrics,
	summarizeAniListRateLimitHints
} from '../utils/anime/metrics';
import { normalizeMediaCore } from '../utils/anime/normalizers';
import { MEDIA_BY_ID_QUERY, SEARCH_ANIME_QUERY } from '../utils/anime/queries';

export { createAniListRequestMetrics, summarizeAniListRateLimitHints };
export type { AniListRateLimitHints, AniListRequestMetrics };

export async function searchAniListAnimeCandidates(
	search: string,
	perPage = 10,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore[]> {
	const cleaned = search.trim();
	if (cleaned.length === 0) return [];

	const data = await anilistGraphQL<{
		Page?: {
			media?: unknown[];
		};
	}>(
		SEARCH_ANIME_QUERY,
		{
			search: cleaned,
			perPage
		},
		{ metrics, kind: 'search' }
	);

	const mediaRows = Array.isArray(data.Page?.media) ? data.Page?.media : [];
	const normalized: AniListMediaCore[] = [];
	for (const media of mediaRows ?? []) {
		const row = normalizeMediaCore(media);
		if (row) normalized.push(row);
	}
	return normalized;
}

export async function fetchAniListAnimeMediaById(
	id: number,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore> {
	const data = await anilistGraphQL<{
		Media?: unknown;
	}>(MEDIA_BY_ID_QUERY, { id }, { metrics, kind: 'media' });

	const media = normalizeMediaCore(data.Media);
	if (!media) {
		throw new Error(`AniList Media ${id} not found or invalid`);
	}
	return media;
}
