import type { QueryCtx } from '../_generated/server';
import type { HeaderContributorInput } from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';

import {
	getAniListMediaById,
	getAnimeXrefByTMDB,
	toStudioCredits
} from '../utils/anime/readCredits';

export async function resolveAnimeHeaderCredits(
	ctx: QueryCtx,
	args: {
		tmdbType: MediaType;
		tmdbId: number;
	}
): Promise<HeaderContributorInput[] | null> {
	const xref = await getAnimeXrefByTMDB(ctx, args);
	if (!xref) return null;
	const media = await getAniListMediaById(ctx, xref.anilistId);
	return toStudioCredits(media);
}
