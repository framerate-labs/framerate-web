import type { MediaType, NormalizedMediaDetails } from './services/detailsService';
import type { MediaSource } from './lib/mediaLookup';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalMutation, internalQuery } from './_generated/server';
import { fetchDetailsFromTMDB } from './services/detailsService';
import { getMovieBySource, getTVShowBySource } from './lib/mediaLookup';

// Argument validators
const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));

/**
 * Internal Query: Get stored media images from DB.
 *
 * Retrieves custom poster/backdrop paths for a media item if it exists in the DB.
 * Returns null if not found, or the stored image paths (which may be custom overrides).
 */
export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			);

			if (!movie) return null;
			return {
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath
			};
		} else {
			const tvShow = await getTVShowBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			);

			if (!tvShow) return null;
			return {
				posterPath: tvShow.posterPath,
				backdropPath: tvShow.backdropPath
			};
		}
	}
});

/**
 * Internal Mutation: Insert new media into DB (upsert pattern).
 *
 * Checks if media exists first to prevent duplicates from race conditions.
 * Only inserts if the media doesn't already exist.
 */
export const insertMedia = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null())
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			// Check if already exists (handles race conditions)
			const existing = await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			);
			if (existing) return;

			// Create movie record with appropriate source ID field
			const movieData: {
				tmdbId?: number;
				traktId?: number;
				imdbId?: string;
				title: string;
				posterPath: string | null;
				backdropPath: string | null;
				releaseDate: string | null;
				slug: null;
			} = {
				title: args.title,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				slug: null
			};

			if (args.source === 'tmdb') {
				movieData.tmdbId = args.externalId as number;
			} else if (args.source === 'trakt') {
				movieData.traktId = args.externalId as number;
			} else if (args.source === 'imdb') {
				movieData.imdbId = args.externalId as string;
			}

			await ctx.db.insert('movies', movieData);
		} else {
			// Check if already exists (handles race conditions)
			const existing = await getTVShowBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			);
			if (existing) return;

			// Create TV show record with appropriate source ID field
			const tvShowData: {
				tmdbId?: number;
				traktId?: number;
				imdbId?: string;
				title: string;
				posterPath: string | null;
				backdropPath: string | null;
				releaseDate: string | null;
				slug: null;
			} = {
				title: args.title,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				slug: null
			};

			if (args.source === 'tmdb') {
				tvShowData.tmdbId = args.externalId as number;
			} else if (args.source === 'trakt') {
				tvShowData.traktId = args.externalId as number;
			} else if (args.source === 'imdb') {
				tvShowData.imdbId = args.externalId as string;
			}

			await ctx.db.insert('tvShows', tvShowData);
		}
	}
});

/**
 * Action: Get media details from external source.
 *
 * Fetches movie or TV details from the specified data source (currently TMDB only).
 * Stores the media in DB if not present, and returns details with any custom
 * poster/backdrop overrides from DB.
 *
 * Performance: DB query and external API fetch run in parallel. Mutation only runs
 * if media doesn't exist in DB (first-time fetch).
 *
 * @param mediaType - Either "movie" or "tv"
 * @param id - External media ID (TMDB ID, Trakt ID, or IMDB ID)
 * @param source - Data source (defaults to "tmdb"). Currently only "tmdb" is supported.
 * @returns Normalized movie or TV details with DB image overrides
 */
export const get = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.union(v.number(), v.string()),
		source: v.optional(sourceValidator)
	},
	handler: async (ctx, args): Promise<NormalizedMediaDetails> => {
		const source = (args.source ?? 'tmdb') as MediaSource;

		// Validate only TMDB is supported for now
		if (source !== 'tmdb') {
			throw new Error(
				`Source '${source}' is not yet implemented. Currently only 'tmdb' is supported for details.`
			);
		}

		// Validate ID type for TMDB (must be number)
		if (typeof args.id !== 'number') {
			throw new Error('TMDB IDs must be numbers');
		}

		// Run DB query and TMDB fetch in parallel for better performance
		const [storedMedia, details] = await Promise.all([
			ctx.runQuery(internal.details.getStoredMedia, {
				mediaType: args.mediaType as MediaType,
				source: source,
				externalId: args.id
			}),
			fetchDetailsFromTMDB(args.mediaType as MediaType, args.id)
		]);

		// If media exists in DB, use stored images (may be custom overrides)
		if (storedMedia) {
			return {
				...details,
				posterPath: storedMedia.posterPath ?? details.posterPath,
				backdropPath: storedMedia.backdropPath ?? details.backdropPath
			};
		}

		// Media not in DB - insert it for future custom image overrides
		// Await to ensure media is stored before returning (prevents race conditions with reviews)
		await ctx.runMutation(internal.details.insertMedia, {
			mediaType: args.mediaType as MediaType,
			source: source,
			externalId: args.id,
			title: details.title,
			posterPath: details.posterPath,
			backdropPath: details.backdropPath,
			releaseDate: details.releaseDate
		});

		return details;
	}
});
