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
): Promise<TVShowDoc | null> {
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

export async function getMovieOverrideByTMDBId(
	ctx: QueryCtx | MutationCtx,
	tmdbId: number
): Promise<MovieOverrideDoc | null> {
	const rows = await ctx.db
		.query('movieOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	if (rows.length === 0) return null;
	if (rows.length === 1) return rows[0] ?? null;
	return rows
		.slice()
		.sort(
			(a, b) =>
				(b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b._creationTime ?? 0) - (a._creationTime ?? 0)
		)[0]!;
}

export async function getTVOverrideByTMDBId(
	ctx: QueryCtx | MutationCtx,
	tmdbId: number
): Promise<TVOverrideDoc | null> {
	const rows = await ctx.db
		.query('tvOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	if (rows.length === 0) return null;
	if (rows.length === 1) return rows[0] ?? null;
	return rows
		.slice()
		.sort(
			(a, b) =>
				(b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b._creationTime ?? 0) - (a._creationTime ?? 0)
		)[0]!;
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
