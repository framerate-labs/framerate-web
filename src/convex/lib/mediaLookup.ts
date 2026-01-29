import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

export type MediaSource = 'tmdb' | 'trakt' | 'imdb';
export type MediaType = 'movie' | 'tv';

/**
 * Looks up a movie by source and external ID.
 *
 * @param ctx - Query or Mutation context
 * @param source - Data source (tmdb, trakt, imdb)
 * @param externalId - External ID from the source (number for tmdb/trakt, string for imdb)
 * @returns Movie document or null if not found
 */
export async function getMovieBySource(
	ctx: QueryCtx | MutationCtx,
	source: MediaSource,
	externalId: number | string
): Promise<{ _id: Id<'movies'>; tmdbId?: number; traktId?: number; imdbId?: string; title: string; posterPath: string | null; backdropPath: string | null; releaseDate: string | null; slug: string | null } | null> {
	if (source === 'tmdb') {
		return await ctx.db
			.query('movies')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', externalId as number))
			.unique();
	} else if (source === 'trakt') {
		return await ctx.db
			.query('movies')
			.withIndex('by_traktId', (q) => q.eq('traktId', externalId as number))
			.unique();
	} else if (source === 'imdb') {
		return await ctx.db
			.query('movies')
			.withIndex('by_imdbId', (q) => q.eq('imdbId', externalId as string))
			.unique();
	}
	return null;
}

/**
 * Looks up a TV show by source and external ID.
 *
 * @param ctx - Query or Mutation context
 * @param source - Data source (tmdb, trakt, imdb)
 * @param externalId - External ID from the source (number for tmdb/trakt, string for imdb)
 * @returns TV show document or null if not found
 */
export async function getTVShowBySource(
	ctx: QueryCtx | MutationCtx,
	source: MediaSource,
	externalId: number | string
): Promise<{ _id: Id<'tvShows'>; tmdbId?: number; traktId?: number; imdbId?: string; title: string; posterPath: string | null; backdropPath: string | null; releaseDate: string | null; slug: string | null } | null> {
	if (source === 'tmdb') {
		return await ctx.db
			.query('tvShows')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', externalId as number))
			.unique();
	} else if (source === 'trakt') {
		return await ctx.db
			.query('tvShows')
			.withIndex('by_traktId', (q) => q.eq('traktId', externalId as number))
			.unique();
	} else if (source === 'imdb') {
		return await ctx.db
			.query('tvShows')
			.withIndex('by_imdbId', (q) => q.eq('imdbId', externalId as string))
			.unique();
	}
	return null;
}

/**
 * Gets the external ID from a media document based on source.
 *
 * @param media - Movie or TV show document
 * @param source - Data source to extract ID for
 * @returns External ID or undefined if not set
 */
export function getExternalId(
	media: { tmdbId?: number; traktId?: number; imdbId?: string },
	source: MediaSource
): number | string | undefined {
	if (source === 'tmdb') return media.tmdbId;
	if (source === 'trakt') return media.traktId;
	if (source === 'imdb') return media.imdbId;
	return undefined;
}
