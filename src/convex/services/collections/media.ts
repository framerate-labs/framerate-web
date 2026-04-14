import type { MutationCtx } from '../../_generated/server';

import { ensureMediaRecord, scheduleDetailHydrationForTMDB } from '../reviewService';
import { getFinalMovie, getFinalTV } from '../../utils/mediaLookup';

export async function loadCanonicalMediaForCollectionItem(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number | string;
		title: string;
		posterPath: string | null;
	}
) {
	const now = Date.now();
	const ensured = await ensureMediaRecord(ctx, {
		mediaType: args.mediaType,
		source: args.source,
		externalId: args.externalId,
		title: args.title,
		posterPath: args.posterPath,
		now
	});

	if (ensured.shouldHydrateDetails) {
		await scheduleDetailHydrationForTMDB(ctx, args.mediaType, args.source, args.externalId);
	}

	if (ensured.mediaType === 'movie') {
		const base = await ctx.db.get(ensured.mediaId);
		if (!base) throw new Error('Movie not found.');
		const movie = await getFinalMovie(ctx, base);
		if (movie.isAnime == null) {
			throw new Error('This title is still being enriched. Try again in a moment.');
		}
		return {
			mediaType: 'movie' as const,
			movieId: ensured.mediaId,
			tvShowId: null,
			tmdbId: movie.tmdbId ?? null,
			title: movie.title,
			posterPath: movie.posterPath ?? args.posterPath ?? null,
			releaseDate: movie.releaseDate ?? null,
			isAnime: movie.isAnime
		};
	}

	const base = await ctx.db.get(ensured.mediaId);
	if (!base) throw new Error('Series not found.');
	const tvShow = await getFinalTV(ctx, base);
	if (tvShow.isAnime == null) {
		throw new Error('This title is still being enriched. Try again in a moment.');
	}
	return {
		mediaType: 'tv' as const,
		movieId: null,
		tvShowId: ensured.mediaId,
		tmdbId: tvShow.tmdbId ?? null,
		title: tvShow.title,
		posterPath: tvShow.posterPath ?? args.posterPath ?? null,
		releaseDate: tvShow.releaseDate ?? null,
		isAnime: tvShow.isAnime
	};
}
