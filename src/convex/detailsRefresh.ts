import type { MediaType } from './types/mediaTypes';
import type {
	InsertMediaArgs,
	RefreshCandidate,
	RefreshIfStaleResult,
	StoredMovieDoc,
	StoredTVDoc,
	StoredMediaSnapshot,
	SweepStaleDetailsResult,
	SyncPolicy
} from './types/detailsType';
import type { MediaSource } from './utils/mediaLookup';

import { v } from 'convex/values';

import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import {
	cloneCreatorCredits,
	dedupeCreatorCredits
} from './services/detailsService';
import {
	DEFAULT_DETAIL_REFRESH_CONFIG,
	computeRefreshErrorBackoffMs,
	createDetailRefreshLeaseKey,
	runRefreshIfStale,
	runSweepStaleDetails
} from './services/detailsRefreshService';
import {
	buildMovieInsertDoc,
	buildMoviePatch,
	buildTVInsertDoc,
	buildTVPatch
} from './utils/detailsUtils';
import { getMovieBySource, getTVShowBySource } from './utils/mediaLookup';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;

const DETAIL_REFRESH_CONFIG = {
	detailSchemaVersion: DETAIL_SCHEMA_VERSION,
	...DEFAULT_DETAIL_REFRESH_CONFIG
} as const;

const MOVIE_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'db_authoritative',
	backdropPath: 'db_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	runtime: 'tmdb_authoritative',
	isAnime: 'db_authoritative',
	director: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const TV_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'db_authoritative',
	backdropPath: 'db_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	numberOfSeasons: 'tmdb_authoritative',
	lastAirDate: 'tmdb_authoritative',
	lastEpisodeToAir: 'tmdb_authoritative',
	nextEpisodeToAir: 'tmdb_authoritative',
	isAnime: 'db_authoritative',
	creator: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const detailsEpisodeValidator = v.object({
	airDate: v.union(v.string(), v.null()),
	seasonNumber: v.number(),
	episodeNumber: v.number()
});

const detailCreatorCreditValidator = v.object({
	type: v.union(v.literal('person'), v.literal('company')),
	tmdbId: v.union(v.number(), v.null()),
	name: v.string(),
	role: v.union(v.string(), v.null())
});

export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movie) return null;
			return {
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath,
				detailSchemaVersion: movie.detailSchemaVersion ?? null,
				detailFetchedAt: movie.detailFetchedAt ?? null,
				nextRefreshAt: movie.nextRefreshAt ?? null,
				releaseDate: movie.releaseDate ?? null,
				overview: movie.overview ?? null,
				status: movie.status ?? null,
				runtime: movie.runtime ?? null,
				director: movie.director ?? null,
				creatorCredits: movie.creatorCredits
			} satisfies StoredMediaSnapshot;
		}

		const tvShow = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShow) return null;
		return {
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
			detailFetchedAt: tvShow.detailFetchedAt ?? null,
			nextRefreshAt: tvShow.nextRefreshAt ?? null,
			releaseDate: tvShow.releaseDate ?? null,
			overview: tvShow.overview ?? null,
			status: tvShow.status ?? null,
			numberOfSeasons: tvShow.numberOfSeasons ?? null,
			lastAirDate: tvShow.lastAirDate ?? null,
			lastEpisodeToAir: tvShow.lastEpisodeToAir ?? null,
			nextEpisodeToAir: tvShow.nextEpisodeToAir ?? null,
			creator: tvShow.creator ?? null,
			creatorCredits: tvShow.creatorCredits
		} satisfies StoredMediaSnapshot;
	}
});

export const insertMedia = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		overview: v.union(v.string(), v.null()),
		status: v.string(),
		runtime: v.union(v.number(), v.null()),
		numberOfSeasons: v.optional(v.number()),
		lastAirDate: v.union(v.string(), v.null()),
		lastEpisodeToAir: v.optional(v.union(detailsEpisodeValidator, v.null())),
		nextEpisodeToAir: v.optional(v.union(detailsEpisodeValidator, v.null())),
		detailSchemaVersion: v.number(),
		detailFetchedAt: v.number(),
		nextRefreshAt: v.number(),
		isAnime: v.boolean(),
		director: v.union(v.string(), v.null()),
		creator: v.union(v.string(), v.null()),
		creatorCredits: v.array(detailCreatorCreditValidator)
	},
	handler: async (ctx, rawArgs) => {
		const args = rawArgs as InsertMediaArgs;
		const incomingCreatorCredits = dedupeCreatorCredits(
			cloneCreatorCredits(args.creatorCredits)
		);

		if (args.mediaType === 'movie') {
			const existing = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!existing) {
				await ctx.db.insert('movies', buildMovieInsertDoc(args, incomingCreatorCredits));
				return;
			}

			const patch = buildMoviePatch(existing, args, incomingCreatorCredits, MOVIE_SYNC_POLICY);
			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(existing._id, patch);
			}
			return;
		}

		const existing = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!existing) {
			await ctx.db.insert('tvShows', buildTVInsertDoc(args, incomingCreatorCredits));
			return;
		}

		const patch = buildTVPatch(existing, args, incomingCreatorCredits, TV_SYNC_POLICY);
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existing._id, patch);
		}
	}
});

export const tryAcquireRefreshLease = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.number(),
		now: v.number(),
		ttlMs: v.number(),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const refreshKey = createDetailRefreshLeaseKey(
			args.mediaType as MediaType,
			args.source as MediaSource,
			args.externalId
		);
		const existing = await ctx.db
			.query('detailRefreshLeases')
			.withIndex('by_refreshKey', (q) => q.eq('refreshKey', refreshKey))
			.collect();
		const [activeLease, ...duplicateLeases] = existing;
		for (const duplicateLease of duplicateLeases) {
			await ctx.db.delete(duplicateLease._id);
		}
		const leaseExpiresAt = args.now + args.ttlMs;

		if (!activeLease) {
			const leaseId = await ctx.db.insert('detailRefreshLeases', {
				refreshKey,
				mediaType: args.mediaType as MediaType,
				source: args.source as MediaSource,
				externalId: args.externalId,
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return { acquired: true, leaseId, leaseExpiresAt };
		}

		if (activeLease.leaseExpiresAt <= args.now) {
			await ctx.db.patch(activeLease._id, {
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return {
				acquired: true,
				leaseId: activeLease._id,
				leaseExpiresAt
			};
		}

		return {
			acquired: false,
			leaseId: null,
			leaseExpiresAt: activeLease.leaseExpiresAt
		};
	}
});

export const releaseRefreshLease = internalMutation({
	args: {
		leaseId: v.id('detailRefreshLeases'),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const lease = await ctx.db.get(args.leaseId);
		if (!lease) return;
		if (lease.owner !== args.owner) return;
		await ctx.db.delete(args.leaseId);
	}
});

export const pruneExpiredRefreshLeases = internalMutation({
	args: {
		now: v.number(),
		limit: v.number()
	},
	handler: async (ctx, args) => {
		const expired = await ctx.db
			.query('detailRefreshLeases')
			.withIndex('by_leaseExpiresAt', (q) => q.lte('leaseExpiresAt', args.now))
			.take(args.limit);

		for (const lease of expired) {
			await ctx.db.delete(lease._id);
		}

		return { pruned: expired.length };
	}
});

export const listStaleRefreshCandidates = internalQuery({
	args: {
		now: v.number(),
		limitPerType: v.number()
	},
	handler: async (ctx, args): Promise<RefreshCandidate[]> => {
		const [movies, tvShows] = await Promise.all([
			ctx.db
				.query('movies')
				.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', args.now))
				.take(args.limitPerType),
			ctx.db
				.query('tvShows')
				.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', args.now))
				.take(args.limitPerType)
		]);

		const movieCandidates: RefreshCandidate[] = movies
			.filter((movie) => typeof movie.tmdbId === 'number')
			.map((movie) => ({
				mediaType: 'movie',
				id: movie.tmdbId as number,
				nextRefreshAt: movie.nextRefreshAt ?? 0
			}));

		const tvCandidates: RefreshCandidate[] = tvShows
			.filter((tvShow) => typeof tvShow.tmdbId === 'number')
			.map((tvShow) => ({
				mediaType: 'tv',
				id: tvShow.tmdbId as number,
				nextRefreshAt: tvShow.nextRefreshAt ?? 0
			}));

		return [...movieCandidates, ...tvCandidates].sort((a, b) => a.nextRefreshAt - b.nextRefreshAt);
	}
});

export const recordRefreshFailure = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		failedAt: v.number()
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movie) return;
			const nextErrorCount = (movie.refreshErrorCount ?? 0) + 1;
			const nextRefreshAt = args.failedAt + computeRefreshErrorBackoffMs(nextErrorCount);
			await ctx.db.patch(movie._id, {
				refreshErrorCount: nextErrorCount,
				lastRefreshErrorAt: args.failedAt,
				nextRefreshAt
			});
			return;
		}

		const tvShow = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShow) return;
		const nextErrorCount = (tvShow.refreshErrorCount ?? 0) + 1;
		const nextRefreshAt = args.failedAt + computeRefreshErrorBackoffMs(nextErrorCount);
		await ctx.db.patch(tvShow._id, {
			refreshErrorCount: nextErrorCount,
			lastRefreshErrorAt: args.failedAt,
			nextRefreshAt
		});
	}
});

export const refreshIfStale = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.union(v.number(), v.string()),
		source: v.optional(sourceValidator),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<RefreshIfStaleResult> => {
		return await runRefreshIfStale(
			ctx,
			{
				mediaType: args.mediaType,
				id: args.id,
				source: args.source,
				force: args.force
			},
			DETAIL_REFRESH_CONFIG
		);
	}
});

export const sweepStaleDetails = internalAction({
	args: {},
	handler: async (ctx): Promise<SweepStaleDetailsResult> => {
		return await runSweepStaleDetails(ctx, DETAIL_REFRESH_CONFIG);
	}
});
