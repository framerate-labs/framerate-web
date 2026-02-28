import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { MediaSource } from '../types/mediaTypes';

export type { MediaSource, MediaType } from '../types/mediaTypes';

export type MovieDoc = Doc<'movies'>;
export type TVShowDoc = Doc<'tvShows'>;
export type MovieOverrideDoc = Doc<'movieOverrides'>;
export type TVOverrideDoc = Doc<'tvOverrides'>;
export type FinalMovieDoc = MovieDoc;
export type FinalTVShowDoc = TVShowDoc;

function latestByUpdatedAt<T extends { updatedAt?: number; _creationTime?: number }>(
	rows: T[]
): T | null {
	let best: T | null = null;
	let bestUpdatedAt = Number.NEGATIVE_INFINITY;
	let bestCreatedAt = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const updatedAt = row.updatedAt ?? 0;
		const createdAt = row._creationTime ?? 0;
		if (
			best === null ||
			updatedAt > bestUpdatedAt ||
			(updatedAt === bestUpdatedAt && createdAt > bestCreatedAt)
		) {
			best = row;
			bestUpdatedAt = updatedAt;
			bestCreatedAt = createdAt;
		}
	}
	return best;
}

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
): Promise<MovieDoc | null> {
	switch (source) {
		case 'tmdb':
			return await ctx.db
				.query('movies')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', externalId as number))
				.unique();
		case 'trakt':
			return await ctx.db
				.query('movies')
				.withIndex('by_traktId', (q) => q.eq('traktId', externalId as number))
				.unique();
		case 'imdb':
			return await ctx.db
				.query('movies')
				.withIndex('by_imdbId', (q) => q.eq('imdbId', externalId as string))
				.unique();
		default:
			return null;
	}
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
): Promise<TVShowDoc | null> {
	switch (source) {
		case 'tmdb':
			return await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', externalId as number))
				.unique();
		case 'trakt':
			return await ctx.db
				.query('tvShows')
				.withIndex('by_traktId', (q) => q.eq('traktId', externalId as number))
				.unique();
		case 'imdb':
			return await ctx.db
				.query('tvShows')
				.withIndex('by_imdbId', (q) => q.eq('imdbId', externalId as string))
				.unique();
		default:
			return null;
	}
}

export async function getMovieOverrideByTMDBId(
	ctx: QueryCtx | MutationCtx,
	tmdbId: number
): Promise<MovieOverrideDoc | null> {
	const rows = await ctx.db
		.query('movieOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	return latestByUpdatedAt(rows);
}

export async function getTVOverrideByTMDBId(
	ctx: QueryCtx | MutationCtx,
	tmdbId: number
): Promise<TVOverrideDoc | null> {
	const rows = await ctx.db
		.query('tvOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	return latestByUpdatedAt(rows);
}

export async function getFinalMovie(
	ctx: QueryCtx | MutationCtx,
	base: MovieDoc
): Promise<FinalMovieDoc> {
	const tmdbId = base.tmdbId;
	if (typeof tmdbId !== 'number') return base;
	const override = await getMovieOverrideByTMDBId(ctx, tmdbId);
	if (!override) return base;
	return {
		...base,
		title: override.title !== undefined ? override.title : base.title,
		isAnime: override.isAnime !== undefined ? override.isAnime : base.isAnime,
		isAnimeSource:
			override.isAnimeSource !== undefined ? override.isAnimeSource : base.isAnimeSource,
		posterPath: override.posterPath !== undefined ? (override.posterPath ?? null) : base.posterPath,
		backdropPath:
			override.backdropPath !== undefined ? (override.backdropPath ?? null) : base.backdropPath,
		releaseDate:
			override.releaseDate !== undefined ? (override.releaseDate ?? null) : base.releaseDate,
		overview: override.overview !== undefined ? (override.overview ?? null) : base.overview,
		status: override.status !== undefined ? (override.status ?? null) : base.status,
		runtime: override.runtime !== undefined ? (override.runtime ?? null) : base.runtime,
		creatorCredits:
			override.creatorCredits !== undefined ? override.creatorCredits : base.creatorCredits
	};
}

export async function getFinalTV(
	ctx: QueryCtx | MutationCtx,
	base: TVShowDoc
): Promise<FinalTVShowDoc> {
	const tmdbId = base.tmdbId;
	if (typeof tmdbId !== 'number') return base;
	const override = await getTVOverrideByTMDBId(ctx, tmdbId);
	if (!override) return base;
	return {
		...base,
		title: override.title !== undefined ? override.title : base.title,
		isAnime: override.isAnime !== undefined ? override.isAnime : base.isAnime,
		isAnimeSource:
			override.isAnimeSource !== undefined ? override.isAnimeSource : base.isAnimeSource,
		posterPath: override.posterPath !== undefined ? (override.posterPath ?? null) : base.posterPath,
		backdropPath:
			override.backdropPath !== undefined ? (override.backdropPath ?? null) : base.backdropPath,
		releaseDate:
			override.releaseDate !== undefined ? (override.releaseDate ?? null) : base.releaseDate,
		overview: override.overview !== undefined ? (override.overview ?? null) : base.overview,
		status: override.status !== undefined ? (override.status ?? null) : base.status,
		numberOfSeasons:
			override.numberOfSeasons !== undefined
				? (override.numberOfSeasons ?? null)
				: base.numberOfSeasons,
		lastAirDate:
			override.lastAirDate !== undefined ? (override.lastAirDate ?? null) : base.lastAirDate,
		lastEpisodeToAir:
			override.lastEpisodeToAir !== undefined
				? (override.lastEpisodeToAir ?? null)
				: base.lastEpisodeToAir,
		nextEpisodeToAir:
			override.nextEpisodeToAir !== undefined
				? (override.nextEpisodeToAir ?? null)
				: base.nextEpisodeToAir,
		creatorCredits:
			override.creatorCredits !== undefined ? override.creatorCredits : base.creatorCredits
	};
}
