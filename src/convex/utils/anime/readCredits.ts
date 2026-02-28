import type { QueryCtx } from '../../_generated/server';
import type { AniListMediaDoc, AniListStudioDoc } from '../../types/animeReadTypes';
import type { HeaderContributorInput } from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';

function scoreStudio(studio: AniListStudioDoc): number {
	return (studio.isAnimationStudio ? 4 : 0) + (studio.isMain ? 2 : 0);
}

function sortPreferredStudios(studios: AniListStudioDoc[]): AniListStudioDoc[] {
	return [...studios].sort((a, b) => {
		const scoreDelta = scoreStudio(b) - scoreStudio(a);
		if (scoreDelta !== 0) return scoreDelta;
		return a.name.localeCompare(b.name);
	});
}

export function toStudioCredits(media: AniListMediaDoc | null): HeaderContributorInput[] | null {
	if (!media?.studios || media.studios.length === 0) return null;
	const preferred = sortPreferredStudios(media.studios);
	const topScore = scoreStudio(preferred[0]!);
	const selected = preferred.filter((studio) => scoreStudio(studio) === topScore);
	const credits = selected
		.map((studio) => ({
			type: 'company' as const,
			tmdbId: null,
			name: studio.name.trim(),
			role: 'studio',
			source: 'anilist' as const,
			sourceId: studio.anilistStudioId,
			matchMethod: null,
			matchConfidence: null
		}))
		.filter((studio) => studio.name.length > 0);
	return credits.length > 0 ? credits : null;
}

export async function getAniListMediaById(
	ctx: QueryCtx,
	anilistId: number
): Promise<AniListMediaDoc | null> {
	const row = await ctx.db
		.query('anilistMedia')
		.withIndex('by_anilistId', (q) => q.eq('anilistId', anilistId))
		.unique();
	return row ? (row as AniListMediaDoc) : null;
}

export async function getAnimeXrefByTMDB(
	ctx: QueryCtx,
	args: { tmdbType: MediaType; tmdbId: number }
) {
	const row = await ctx.db
		.query('animeXref')
		.withIndex('by_tmdbType_tmdbId', (q) =>
			q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
		)
		.unique();
	return row ?? null;
}
