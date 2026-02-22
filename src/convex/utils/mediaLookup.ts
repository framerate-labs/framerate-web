import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { MediaSource } from '../types/mediaTypes';

export type { MediaSource, MediaType } from '../types/mediaTypes';

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
): Promise<{
	_id: Id<'movies'>;
	tmdbId?: number;
	traktId?: number;
	imdbId?: string;
	title: string;
	posterPath: string | null;
	backdropPath: string | null;
	releaseDate: string | null;
	isAnime?: boolean;
	director?: string | null;
	detailSchemaVersion?: number | null;
	detailFetchedAt?: number | null;
	creatorCredits?: unknown[] | null;
} | null> {
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
): Promise<{
	_id: Id<'tvShows'>;
	tmdbId?: number;
	traktId?: number;
	imdbId?: string;
	title: string;
	posterPath: string | null;
	backdropPath: string | null;
	releaseDate: string | null;
	isAnime?: boolean;
	creator?: string | null;
	detailSchemaVersion?: number | null;
	detailFetchedAt?: number | null;
	creatorCredits?: unknown[] | null;
} | null> {
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
