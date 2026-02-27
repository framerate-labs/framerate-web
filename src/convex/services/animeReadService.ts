import type { QueryCtx } from '../_generated/server';
import type { HeaderContributorInput } from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';

type AniListMediaDoc = {
	anilistId: number;
	studios?: Array<{
		anilistStudioId: number;
		name: string;
		isAnimationStudio?: boolean;
		isMain?: boolean;
	}>;
};

function sortPreferredStudio(
	studios: NonNullable<AniListMediaDoc['studios']>
): NonNullable<AniListMediaDoc['studios']> {
	return [...studios].sort((a, b) => {
		const aScore = (a.isAnimationStudio ? 4 : 0) + (a.isMain ? 2 : 0);
		const bScore = (b.isAnimationStudio ? 4 : 0) + (b.isMain ? 2 : 0);
		if (aScore !== bScore) return bScore - aScore;
		return a.name.localeCompare(b.name);
	});
}

function toStudioCredits(media: AniListMediaDoc | null): HeaderContributorInput[] | null {
	if (!media?.studios || media.studios.length === 0) return null;
	const preferred = sortPreferredStudio(media.studios);
	const topScore = (preferred[0]?.isAnimationStudio ? 4 : 0) + (preferred[0]?.isMain ? 2 : 0);
	const selected = preferred.filter((studio) => {
		const score = (studio.isAnimationStudio ? 4 : 0) + (studio.isMain ? 2 : 0);
		return score === topScore;
	});
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

async function getAniListMediaById(ctx: QueryCtx, anilistId: number): Promise<AniListMediaDoc | null> {
	const rows = await ctx.db
		.query('anilistMedia')
		.withIndex('by_anilistId', (q) => q.eq('anilistId', anilistId))
		.collect();
	return (rows[0] as AniListMediaDoc | undefined) ?? null;
}

export async function resolveAnimeHeaderCredits(
	ctx: QueryCtx,
	args: {
		tmdbType: MediaType;
		tmdbId: number;
	}
): Promise<HeaderContributorInput[] | null> {
	const xrefRows = await ctx.db
		.query('animeXref')
		.withIndex('by_tmdbType_tmdbId', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
		.collect();
	const xref = xrefRows[0] ?? null;
	if (!xref) return null;
	const media = await getAniListMediaById(ctx, xref.anilistId);
	return toStudioCredits(media);
}
