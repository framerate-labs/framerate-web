import type {
	HeaderContributorInput,
	StoredEpisodeSummary,
	StoredMovieDoc,
	StoredTVDoc
} from './types/detailsType';
import type { MediaSource } from './utils/mediaLookup';

import { v } from 'convex/values';

import { internalMutation, query } from './_generated/server';
import {
	buildHeaderContext,
	evaluateStoredMovieDecision,
	evaluateStoredTVDecision
} from './services/detailsService';
import { getMovieBySource, getTVShowBySource } from './utils/mediaLookup';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;

// One-time migration helper: patch legacy rows so required detail fields can be enforced safely.
export const backfillRequiredDetailFields = internalMutation({
	args: {
		limitPerTable: v.number(),
		table: v.optional(v.union(v.literal('movies'), v.literal('tvShows'))),
		cursor: v.optional(v.union(v.string(), v.null())),
		movieCursor: v.optional(v.union(v.string(), v.null())),
		tvShowCursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const table =
			args.table ?? ((args.tvShowCursor ?? null) !== null ? 'tvShows' : 'movies');
		const cursor =
			args.cursor ??
			(table === 'movies' ? (args.movieCursor ?? null) : (args.tvShowCursor ?? null));

		if (table === 'movies') {
			const page = await ctx.db.query('movies').order('asc').paginate({
				numItems: args.limitPerTable,
				cursor
			});
			let patched = 0;

			for (const movie of page.page) {
				const patch: {
					overview?: string | null;
					status?: string | null;
					runtime?: number | null;
					detailSchemaVersion?: number;
					detailFetchedAt?: number | null;
					nextRefreshAt?: number;
					refreshErrorCount?: number;
					lastRefreshErrorAt?: number | null;
					director?: string | null;
					creatorCredits?: HeaderContributorInput[];
				} = {};

				if (movie.overview === undefined) patch.overview = null;
				if (movie.status === undefined) patch.status = null;
				if (movie.runtime === undefined) patch.runtime = null;
				if (movie.detailSchemaVersion === undefined) patch.detailSchemaVersion = 0;
				if (movie.detailFetchedAt === undefined) patch.detailFetchedAt = null;
				if (movie.nextRefreshAt === undefined) patch.nextRefreshAt = now;
				if (movie.refreshErrorCount === undefined) patch.refreshErrorCount = 0;
				if (movie.lastRefreshErrorAt === undefined) patch.lastRefreshErrorAt = null;
				if (movie.director === undefined) patch.director = null;
				if (movie.creatorCredits === undefined) patch.creatorCredits = [];

				if (Object.keys(patch).length > 0) {
					await ctx.db.patch(movie._id, patch);
					patched += 1;
				}
			}

			const nextCursor = page.isDone ? null : page.continueCursor;
			return {
				table,
				scanned: page.page.length,
				patched,
				done: page.isDone,
				nextCursor,
				nextMovieCursor: nextCursor,
				nextTVShowCursor: null,
				moviesDone: page.isDone,
				tvShowsDone: false
			};
		}

		const page = await ctx.db.query('tvShows').order('asc').paginate({
			numItems: args.limitPerTable,
			cursor
		});
		let patched = 0;

		for (const tvShow of page.page) {
			const patch: {
				overview?: string | null;
				status?: string | null;
				numberOfSeasons?: number | null;
				lastAirDate?: string | null;
				lastEpisodeToAir?: StoredEpisodeSummary | null;
				nextEpisodeToAir?: StoredEpisodeSummary | null;
				detailSchemaVersion?: number;
				detailFetchedAt?: number | null;
				nextRefreshAt?: number;
				refreshErrorCount?: number;
				lastRefreshErrorAt?: number | null;
				creator?: string | null;
				creatorCredits?: HeaderContributorInput[];
			} = {};

			if (tvShow.overview === undefined) patch.overview = null;
			if (tvShow.status === undefined) patch.status = null;
			if (tvShow.numberOfSeasons === undefined) patch.numberOfSeasons = null;
			if (tvShow.lastAirDate === undefined) patch.lastAirDate = null;
			if (tvShow.lastEpisodeToAir === undefined) patch.lastEpisodeToAir = null;
			if (tvShow.nextEpisodeToAir === undefined) patch.nextEpisodeToAir = null;
			if (tvShow.detailSchemaVersion === undefined) patch.detailSchemaVersion = 0;
			if (tvShow.detailFetchedAt === undefined) patch.detailFetchedAt = null;
			if (tvShow.nextRefreshAt === undefined) patch.nextRefreshAt = now;
			if (tvShow.refreshErrorCount === undefined) patch.refreshErrorCount = 0;
			if (tvShow.lastRefreshErrorAt === undefined) patch.lastRefreshErrorAt = null;
			if (tvShow.creator === undefined) patch.creator = null;
			if (tvShow.creatorCredits === undefined) patch.creatorCredits = [];

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(tvShow._id, patch);
				patched += 1;
			}
		}

		const nextCursor = page.isDone ? null : page.continueCursor;
		return {
			table,
			scanned: page.page.length,
			patched,
			done: page.isDone,
			nextCursor,
			nextMovieCursor: null,
			nextTVShowCursor: nextCursor,
			moviesDone: false,
			tvShowsDone: page.isDone
		};
	}
});

export const get = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		if (args.mediaType === 'movie') {
			const movie = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movie || movie.tmdbId === undefined) return null;

			const headerContext = buildHeaderContext(
				movie.creatorCredits,
				movie.isAnime ?? false,
				'Directed by'
			);

			const refreshDecision = evaluateStoredMovieDecision(
				{
					detailSchemaVersion: movie.detailSchemaVersion ?? null,
					detailFetchedAt: movie.detailFetchedAt ?? null,
					nextRefreshAt: movie.nextRefreshAt ?? null,
					overview: movie.overview,
					status: movie.status ?? null,
					runtime: movie.runtime,
					creatorCredits: movie.creatorCredits
				},
				now,
				DETAIL_SCHEMA_VERSION
			);

			return {
				mediaType: 'movie' as const,
				id: movie.tmdbId,
				title: movie.title,
				overview: movie.overview ?? null,
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath,
				releaseDate: movie.releaseDate,
				movieRuntime: movie.runtime ?? null,
				tvNumberOfSeasons: null,
				tvStatus: null,
				tvLastAirDate: null,
				tvLastEpisodeToAir: null,
				tvNextEpisodeToAir: null,
				headerContext,
				nextRefreshAt: movie.nextRefreshAt ?? null,
				hardStale: refreshDecision.hardStale,
				isStale: refreshDecision.needsRefresh
			};
		}

		const tvShow = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShow || tvShow.tmdbId === undefined) return null;

		const headerContext = buildHeaderContext(
			tvShow.creatorCredits,
			tvShow.isAnime ?? false,
			'Created by'
		);

		const refreshDecision = evaluateStoredTVDecision(
			{
				detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
				detailFetchedAt: tvShow.detailFetchedAt ?? null,
				nextRefreshAt: tvShow.nextRefreshAt ?? null,
				overview: tvShow.overview,
				status: tvShow.status ?? null,
				numberOfSeasons: tvShow.numberOfSeasons ?? null,
				lastAirDate: tvShow.lastAirDate ?? null,
				creatorCredits: tvShow.creatorCredits
			},
			now,
			DETAIL_SCHEMA_VERSION
		);

		return {
			mediaType: 'tv' as const,
			id: tvShow.tmdbId,
			title: tvShow.title,
			overview: tvShow.overview ?? null,
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			releaseDate: tvShow.releaseDate,
			movieRuntime: null,
			tvNumberOfSeasons: tvShow.numberOfSeasons ?? null,
			tvStatus: tvShow.status ?? null,
			tvLastAirDate: tvShow.lastAirDate ?? null,
			tvLastEpisodeToAir: tvShow.lastEpisodeToAir ?? null,
			tvNextEpisodeToAir: tvShow.nextEpisodeToAir ?? null,
			headerContext,
			nextRefreshAt: tvShow.nextRefreshAt ?? null,
			hardStale: refreshDecision.hardStale,
			isStale: refreshDecision.needsRefresh
		};
	}
});
