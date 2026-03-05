import type { QueryCtx } from '../_generated/server';

import { getMovieOverrideByTMDBId, getTVOverrideByTMDBId } from './mediaLookup';

export type MediaCardSummary = {
	id: number;
	mediaType: 'movie' | 'tv' | 'person';
	title: string;
	posterPath: string | null;
	knownForDepartment?: string | null;
	releaseYear?: number | null;
};

export async function buildMediaCardSummaries(
	ctx: QueryCtx,
	items: MediaCardSummary[]
): Promise<MediaCardSummary[]> {
	const movieIds = uniqueIdsForMediaType(items, 'movie');
	const tvIds = uniqueIdsForMediaType(items, 'tv');

	const [movieOverrides, tvOverrides] = await Promise.all([
		loadMovieOverrideMap(ctx, movieIds),
		loadTVOverrideMap(ctx, tvIds)
	]);

	return items.map((item) => {
		if (item.mediaType === 'movie') {
			const override = movieOverrides.get(item.id);
			if (!override) return item;
			return {
				...item,
				title: override.title !== undefined ? override.title : item.title,
				posterPath:
					override.posterPath !== undefined ? (override.posterPath ?? null) : item.posterPath
			};
		}

		if (item.mediaType === 'tv') {
			const override = tvOverrides.get(item.id);
			if (!override) return item;
			return {
				...item,
				title: override.title !== undefined ? override.title : item.title,
				posterPath:
					override.posterPath !== undefined ? (override.posterPath ?? null) : item.posterPath
			};
		}

		return item;
	});
}

function uniqueIdsForMediaType(items: MediaCardSummary[], mediaType: 'movie' | 'tv'): number[] {
	return [...new Set(items.filter((item) => item.mediaType === mediaType).map((item) => item.id))];
}

async function loadMovieOverrideMap(ctx: QueryCtx, tmdbIds: number[]) {
	if (tmdbIds.length === 0) {
		return new Map<number, Awaited<ReturnType<typeof getMovieOverrideByTMDBId>>>();
	}

	const rows = await Promise.all(
		tmdbIds.map(async (tmdbId) => [tmdbId, await getMovieOverrideByTMDBId(ctx, tmdbId)] as const)
	);
	return new Map(rows);
}

async function loadTVOverrideMap(ctx: QueryCtx, tmdbIds: number[]) {
	if (tmdbIds.length === 0) {
		return new Map<number, Awaited<ReturnType<typeof getTVOverrideByTMDBId>>>();
	}

	const rows = await Promise.all(
		tmdbIds.map(async (tmdbId) => [tmdbId, await getTVOverrideByTMDBId(ctx, tmdbId)] as const)
	);
	return new Map(rows);
}
