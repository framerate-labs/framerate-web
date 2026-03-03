import type {
	HeaderContributorInput,
	StoredEpisodeSummary,
	StoredMovieDoc,
	StoredTVDoc
} from './types/detailsType';

import { v } from 'convex/values';

import { internalMutation, mutation, query } from './_generated/server';
import { resolveAnimeHeaderCredits } from './services/animeReadService';
import { resolveAnimeStudioStatus } from './utils/details/animeStudioStatus';
import { mergeCreatorCreditsForSource } from './utils/details/creatorCredits';
import { buildHeaderContext, hasAniListStudioCredits } from './utils/details/headerContext';
import {
	clearMovieOverridesByTMDBId,
	clearTVOverridesByTMDBId,
	getCanonicalMovieOverrideAndCleanup,
	getCanonicalTVOverrideAndCleanup
} from './utils/details/overrideRows';
import {
	evaluateStoredMovieDecision,
	evaluateStoredTVDecision
} from './utils/details/refreshPolicy';
import { sameHeaderContributors } from './utils/details/syncPolicy';
import {
	getFinalMovie,
	getFinalTV,
	getMovieBySource,
	getTVShowBySource
} from './utils/mediaLookup';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;
const detailCreatorCreditValidator = v.object({
	type: v.union(v.literal('person'), v.literal('company')),
	tmdbId: v.union(v.number(), v.null()),
	name: v.string(),
	role: v.union(v.string(), v.null()),
	source: v.optional(v.union(v.literal('tmdb'), v.literal('anilist'))),
	sourceId: v.optional(v.union(v.number(), v.null())),
	matchMethod: v.optional(
		v.union(
			v.literal('exact'),
			v.literal('normalized'),
			v.literal('fuzzy'),
			v.literal('manual'),
			v.null()
		)
	),
	matchConfidence: v.optional(v.union(v.number(), v.null()))
});

function withDefined<T extends Record<string, unknown>>(values: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

function applyUnsetFields<T extends Record<string, unknown>>(
	values: Partial<T>,
	unsetFields: string[] | undefined
): Partial<T> {
	if (!unsetFields || unsetFields.length === 0) return values;
	const next = { ...values } as Partial<T>;
	for (const field of unsetFields) {
		(next as Record<string, unknown>)[field] = undefined;
	}
	return next;
}

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
		const table = args.table ?? ((args.tvShowCursor ?? null) !== null ? 'tvShows' : 'movies');
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
				seasons?: Array<{
					id: number;
					name: string;
					overview: string | null;
					airDate: string | null;
					episodeCount: number | null;
					posterPath: string | null;
					seasonNumber: number;
					voteAverage: number | null;
				}> | null;
				lastAirDate?: string | null;
				lastEpisodeToAir?: StoredEpisodeSummary | null;
				nextEpisodeToAir?: StoredEpisodeSummary | null;
				detailSchemaVersion?: number;
				detailFetchedAt?: number | null;
				nextRefreshAt?: number;
				refreshErrorCount?: number;
				lastRefreshErrorAt?: number | null;
				creatorCredits?: HeaderContributorInput[];
			} = {};

			if (tvShow.overview === undefined) patch.overview = null;
			if (tvShow.status === undefined) patch.status = null;
			if (tvShow.numberOfSeasons === undefined) patch.numberOfSeasons = null;
			if (tvShow.seasons === undefined) patch.seasons = null;
			if (tvShow.lastAirDate === undefined) patch.lastAirDate = null;
			if (tvShow.lastEpisodeToAir === undefined) patch.lastEpisodeToAir = null;
			if (tvShow.nextEpisodeToAir === undefined) patch.nextEpisodeToAir = null;
			if (tvShow.detailSchemaVersion === undefined) patch.detailSchemaVersion = 0;
			if (tvShow.detailFetchedAt === undefined) patch.detailFetchedAt = null;
			if (tvShow.nextRefreshAt === undefined) patch.nextRefreshAt = now;
			if (tvShow.refreshErrorCount === undefined) patch.refreshErrorCount = 0;
			if (tvShow.lastRefreshErrorAt === undefined) patch.lastRefreshErrorAt = null;
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

export const syncAnimeCreatorCreditsForTMDB = internalMutation({
	args: {
		tmdbType: mediaTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		if (args.tmdbType === 'movie') {
			const movie = (await getMovieBySource(ctx, 'tmdb', args.tmdbId)) as StoredMovieDoc | null;
			if (!movie || movie.tmdbId === undefined)
				return { updated: false, reason: 'missing' as const };
			if (movie.isAnime !== true) return { updated: false, reason: 'not_anime' as const };
			const hadAniListStudioCredits = hasAniListStudioCredits(movie.creatorCredits);

			const animeCredits =
				(await resolveAnimeHeaderCredits(ctx, {
					tmdbType: 'movie',
					tmdbId: movie.tmdbId
				})) ?? [];
			if (animeCredits.length === 0) {
				return {
					updated: false,
					reason: hadAniListStudioCredits
						? ('preserved_existing_anilist' as const)
						: ('resolver_miss' as const)
				};
			}
			const mergedCreatorCredits = mergeCreatorCreditsForSource(
				movie.creatorCredits,
				animeCredits,
				'anilist'
			);
			if (sameHeaderContributors(movie.creatorCredits ?? [], mergedCreatorCredits)) {
				return { updated: false, reason: 'unchanged' as const };
			}

			await ctx.db.patch(movie._id, { creatorCredits: mergedCreatorCredits });
			return { updated: true, reason: 'patched' as const };
		}

		const tvShow = (await getTVShowBySource(ctx, 'tmdb', args.tmdbId)) as StoredTVDoc | null;
		if (!tvShow || tvShow.tmdbId === undefined)
			return { updated: false, reason: 'missing' as const };
		if (tvShow.isAnime !== true) return { updated: false, reason: 'not_anime' as const };
		const hadAniListStudioCredits = hasAniListStudioCredits(tvShow.creatorCredits);

		const animeCredits =
			(await resolveAnimeHeaderCredits(ctx, {
				tmdbType: 'tv',
				tmdbId: tvShow.tmdbId
			})) ?? [];
		if (animeCredits.length === 0) {
			return {
				updated: false,
				reason: hadAniListStudioCredits
					? ('preserved_existing_anilist' as const)
					: ('resolver_miss' as const)
			};
		}
		const mergedCreatorCredits = mergeCreatorCreditsForSource(
			tvShow.creatorCredits,
			animeCredits,
			'anilist'
		);
		if (sameHeaderContributors(tvShow.creatorCredits ?? [], mergedCreatorCredits)) {
			return { updated: false, reason: 'unchanged' as const };
		}

		await ctx.db.patch(tvShow._id, { creatorCredits: mergedCreatorCredits });
		return { updated: true, reason: 'patched' as const };
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
			const movieBase = (await getMovieBySource(
				ctx,
				args.source,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movieBase || movieBase.tmdbId === undefined) return null;
			const movie = (await getFinalMovie(ctx, movieBase)) as StoredMovieDoc;
			const movieTmdbId = movie.tmdbId;
			if (movieTmdbId === undefined) return null;

			const isAnime = movie.isAnime ?? false;
			const animeStudioStatus = await resolveAnimeStudioStatus(
				ctx,
				'movie',
				movieTmdbId,
				movie.creatorCredits,
				isAnime
			);
			const headerContext = buildHeaderContext(
				movie.creatorCredits,
				isAnime,
				'movie',
				animeStudioStatus
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
				id: movieTmdbId,
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

		const tvShowBase = (await getTVShowBySource(
			ctx,
			args.source,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShowBase || tvShowBase.tmdbId === undefined) return null;
		const tvShow = (await getFinalTV(ctx, tvShowBase)) as StoredTVDoc;
		const tvShowTmdbId = tvShow.tmdbId;
		if (tvShowTmdbId === undefined) return null;

		const isAnime = tvShow.isAnime ?? false;
		const animeStudioStatus = await resolveAnimeStudioStatus(
			ctx,
			'tv',
			tvShowTmdbId,
			tvShow.creatorCredits,
			isAnime
		);
		const headerContext = buildHeaderContext(
			tvShow.creatorCredits,
			isAnime,
			'tv',
			animeStudioStatus
		);

		const refreshDecision = evaluateStoredTVDecision(
			{
				detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
				detailFetchedAt: tvShow.detailFetchedAt ?? null,
				nextRefreshAt: tvShow.nextRefreshAt ?? null,
				overview: tvShow.overview,
				status: tvShow.status ?? null,
				numberOfSeasons: tvShow.numberOfSeasons ?? null,
				seasons: tvShow.seasons ?? null,
				lastAirDate: tvShow.lastAirDate ?? null,
				creatorCredits: tvShow.creatorCredits
			},
			now,
			DETAIL_SCHEMA_VERSION
		);

		return {
			mediaType: 'tv' as const,
			id: tvShowTmdbId,
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

export const updateMovieOverrides = mutation({
	args: {
		tmdbId: v.number(),
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		runtime: v.optional(v.union(v.number(), v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		unsetFields: v.optional(
			v.array(
				v.union(
					v.literal('title'),
					v.literal('isAnime'),
					v.literal('isAnimeSource'),
					v.literal('posterPath'),
					v.literal('backdropPath'),
					v.literal('releaseDate'),
					v.literal('overview'),
					v.literal('status'),
					v.literal('runtime'),
					v.literal('creatorCredits')
				)
			)
		)
	},
	handler: async (ctx, args) => {
		const existing = await getCanonicalMovieOverrideAndCleanup(ctx, args.tmdbId);
		const payload = applyUnsetFields(
			withDefined({
				title: args.title,
				isAnime: args.isAnime,
				isAnimeSource: args.isAnimeSource,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				overview: args.overview,
				status: args.status,
				runtime: args.runtime,
				creatorCredits: args.creatorCredits
			}),
			args.unsetFields
		);
		const updatedAt = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...payload, updatedAt });
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('movieOverrides', {
			tmdbId: args.tmdbId,
			...payload,
			updatedAt
		});
		return { ok: true, rowId };
	}
});

export const clearMovieOverrides = mutation({
	args: { tmdbId: v.number() },
	handler: async (ctx, args) => {
		const deleted = await clearMovieOverridesByTMDBId(ctx, args.tmdbId);
		return { ok: true, deleted };
	}
});

export const updateTVOverrides = mutation({
	args: {
		tmdbId: v.number(),
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		numberOfSeasons: v.optional(v.union(v.number(), v.null())),
		lastAirDate: v.optional(v.union(v.string(), v.null())),
		lastEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		nextEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		unsetFields: v.optional(
			v.array(
				v.union(
					v.literal('title'),
					v.literal('isAnime'),
					v.literal('isAnimeSource'),
					v.literal('posterPath'),
					v.literal('backdropPath'),
					v.literal('releaseDate'),
					v.literal('overview'),
					v.literal('status'),
					v.literal('numberOfSeasons'),
					v.literal('lastAirDate'),
					v.literal('lastEpisodeToAir'),
					v.literal('nextEpisodeToAir'),
					v.literal('creatorCredits')
				)
			)
		)
	},
	handler: async (ctx, args) => {
		const existing = await getCanonicalTVOverrideAndCleanup(ctx, args.tmdbId);
		const payload = applyUnsetFields(
			withDefined({
				title: args.title,
				isAnime: args.isAnime,
				isAnimeSource: args.isAnimeSource,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				overview: args.overview,
				status: args.status,
				numberOfSeasons: args.numberOfSeasons,
				lastAirDate: args.lastAirDate,
				lastEpisodeToAir: args.lastEpisodeToAir,
				nextEpisodeToAir: args.nextEpisodeToAir,
				creatorCredits: args.creatorCredits
			}),
			args.unsetFields
		);
		const updatedAt = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...payload, updatedAt });
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('tvOverrides', {
			tmdbId: args.tmdbId,
			...payload,
			updatedAt
		});
		return { ok: true, rowId };
	}
});

export const clearTVOverrides = mutation({
	args: { tmdbId: v.number() },
	handler: async (ctx, args) => {
		const deleted = await clearTVOverridesByTMDBId(ctx, args.tmdbId);
		return { ok: true, deleted };
	}
});
