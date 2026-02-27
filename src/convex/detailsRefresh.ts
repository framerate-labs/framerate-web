import type { Doc } from './_generated/dataModel';
import type {
	InsertMediaArgs,
	RefreshCandidate,
	RefreshIfStaleResult,
	StoredMediaSnapshot,
	StoredMovieDoc,
	StoredTVDoc,
	SweepStaleDetailsResult,
	SyncPolicy
} from './types/detailsType';
import type { MediaType } from './types/mediaTypes';
import type { MediaSource } from './utils/mediaLookup';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import {
	computeRefreshErrorBackoffMs,
	createDetailRefreshLeaseKey,
	DEFAULT_DETAIL_REFRESH_CONFIG,
	runRefreshIfStale
} from './services/detailsRefreshService';
import {
	cloneCreatorCredits,
	dedupeCreatorCredits,
	mergeCreatorCreditsForSource
} from './services/detailsService';
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
const DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY = 100;
const DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY = 40;
const DETAIL_REFRESH_QUEUE_BUSY_RETRY_MS = 15_000;
const DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS = 30 * 24 * 60 * 60_000;

const MOVIE_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'tmdb_authoritative',
	backdropPath: 'tmdb_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	runtime: 'tmdb_authoritative',
	isAnime: 'tmdb_authoritative',
	isAnimeSource: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const TV_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'tmdb_authoritative',
	backdropPath: 'tmdb_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	numberOfSeasons: 'tmdb_authoritative',
	lastAirDate: 'tmdb_authoritative',
	lastEpisodeToAir: 'tmdb_authoritative',
	nextEpisodeToAir: 'tmdb_authoritative',
	isAnime: 'tmdb_authoritative',
	isAnimeSource: 'tmdb_authoritative',
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

function detailRefreshQueueKey(
	mediaType: 'movie' | 'tv',
	source: 'tmdb' | 'trakt' | 'imdb',
	externalId: number
): string {
	return `${source}:${mediaType}:${externalId}`;
}

function parseNumericTMDBId(id: number | string): number | null {
	if (typeof id === 'number' && Number.isFinite(id)) return id;
	if (typeof id !== 'string') return null;
	const trimmed = id.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

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
		isAnimeSource: v.union(v.literal('auto'), v.literal('manual')),
		creatorCredits: v.array(detailCreatorCreditValidator)
	},
	handler: async (ctx, rawArgs) => {
		const args = rawArgs as InsertMediaArgs;
		const incomingCreatorCredits = dedupeCreatorCredits(cloneCreatorCredits(args.creatorCredits));

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

			const mergedCreatorCredits = mergeCreatorCreditsForSource(
				existing.creatorCredits,
				incomingCreatorCredits,
				'tmdb'
			);
			const patch = buildMoviePatch(existing, args, mergedCreatorCredits, MOVIE_SYNC_POLICY);
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

		const mergedCreatorCredits = mergeCreatorCreditsForSource(
			existing.creatorCredits,
			incomingCreatorCredits,
			'tmdb'
		);
		const patch = buildTVPatch(existing, args, mergedCreatorCredits, TV_SYNC_POLICY);
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

export const upsertDetailRefreshQueueRequest = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.number(),
		priority: v.number(),
		now: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const syncKey = detailRefreshQueueKey(args.mediaType, args.source, args.externalId);
		const rows = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
			.collect();
		const [existing, ...dups] = rows;
		for (const dup of dups) await ctx.db.delete(dup._id);
		const force = args.force === true;

		if (!existing) {
			const rowId = await ctx.db.insert('detailRefreshQueue', {
				syncKey,
				mediaType: args.mediaType,
				source: args.source,
				externalId: args.externalId,
				state: 'queued',
				priority: args.priority,
				requestedAt: args.now,
				lastRequestedAt: args.now,
				nextAttemptAt: args.now,
				attemptCount: 0
			});
			return { queued: true, inserted: true, rowId };
		}

		const isStale = (existing.nextRefreshAt ?? 0) <= args.now || existing.lastSuccessAt == null;
		const shouldQueue =
			force ||
			isStale ||
			existing.state === 'error' ||
			existing.state === 'retry' ||
			existing.state === 'queued';
		const nextState =
			existing.state === 'running' && !force ? 'running' : shouldQueue ? 'queued' : existing.state;
		const nextPriority = Math.max(existing.priority, args.priority);
		const nextAttemptAt =
			nextState === 'queued'
				? Math.min(existing.nextAttemptAt ?? args.now, args.now)
				: existing.nextAttemptAt;
		const nextLastError = nextState === 'queued' ? undefined : existing.lastError;
		const needsPatch =
			nextPriority !== existing.priority ||
			(existing.lastRequestedAt ?? 0) !== args.now ||
			nextAttemptAt !== existing.nextAttemptAt ||
			nextState !== existing.state ||
			nextLastError !== existing.lastError;
		if (!needsPatch) {
			return { queued: nextState === 'queued', inserted: false, rowId: existing._id };
		}
		await ctx.db.patch(existing._id, {
			priority: nextPriority,
			lastRequestedAt: args.now,
			nextAttemptAt,
			state: nextState,
			lastError: nextLastError
		});
		return { queued: nextState === 'queued', inserted: false, rowId: existing._id };
	}
});

export const enqueueStaleDetailRefreshQueueJobs = internalAction({
	args: {
		now: v.number(),
		limit: v.optional(v.number()),
		limitPerType: v.optional(v.number()),
		priority: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
		const limitPerType = Math.max(10, Math.min(args.limitPerType ?? 200, 500));
		const priority = args.priority ?? DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY;
		const candidates = await ctx.runQuery(internal.detailsRefresh.listStaleRefreshCandidates, {
			now: args.now,
			limitPerType
		});
		let scanned = 0;
		let queued = 0;
		for (const candidate of candidates as RefreshCandidate[]) {
			if (scanned >= limit) break;
			scanned += 1;
			const result = await ctx.runMutation(
				internal.detailsRefresh.upsertDetailRefreshQueueRequest,
				{
					mediaType: candidate.mediaType,
					source: 'tmdb',
					externalId: candidate.id,
					priority,
					now: args.now,
					force: false
				}
			);
			if ((result as { queued?: boolean }).queued) queued += 1;
		}
		return { scanned, queued };
	}
});

export const claimNextDetailRefreshQueueJob = internalMutation({
	args: {
		now: v.number(),
		mediaType: v.optional(mediaTypeValidator)
	},
	handler: async (ctx, args) => {
		const candidates: Array<Doc<'detailRefreshQueue'>> = [];
		for (const state of ['queued', 'retry'] as const) {
			const rows = await ctx.db
				.query('detailRefreshQueue')
				.withIndex('by_state_nextAttemptAt', (q) =>
					q.eq('state', state).lte('nextAttemptAt', args.now)
				)
				.take(50);
			for (const row of rows) {
				if (args.mediaType && row.mediaType !== args.mediaType) continue;
				candidates.push(row);
			}
		}
		if (candidates.length === 0) return null;
		candidates.sort(
			(a, b) =>
				b.priority - a.priority ||
				(a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) ||
				(a.requestedAt ?? 0) - (b.requestedAt ?? 0)
		);
		const selected = candidates[0]!;
		const nextAttemptCount = (selected.attemptCount ?? 0) + 1;
		await ctx.db.patch(selected._id, {
			state: 'running',
			lastStartedAt: args.now,
			attemptCount: nextAttemptCount,
			lastError: undefined
		});
		return {
			...selected,
			state: 'running' as const,
			attemptCount: nextAttemptCount
		};
	}
});

export const finishDetailRefreshQueueJob = internalMutation({
	args: {
		rowId: v.id('detailRefreshQueue'),
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('retry'), v.literal('error')),
		nextAttemptAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.rowId);
		if (!row) return { ok: false };
		const patch: Record<string, unknown> = {
			lastFinishedAt: args.now,
			lastResultStatus: args.lastResultStatus
		};
		if (args.outcome === 'success') {
			patch.state = 'idle';
			patch.lastSuccessAt = args.now;
			patch.nextRefreshAt =
				args.nextRefreshAt ??
				row.nextRefreshAt ??
				args.now + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS;
			patch.nextAttemptAt =
				args.nextRefreshAt ??
				row.nextRefreshAt ??
				args.now + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS;
			patch.attemptCount = 0;
			patch.lastError = undefined;
		} else if (args.outcome === 'retry') {
			patch.state = 'retry';
			patch.nextAttemptAt = args.nextAttemptAt ?? args.now + 60_000;
			patch.lastError = args.lastError;
		} else {
			patch.state = 'error';
			patch.nextAttemptAt =
				args.nextAttemptAt ??
				args.now + computeRefreshErrorBackoffMs(Math.max(1, row.attemptCount ?? 1));
			patch.lastError = args.lastError;
		}
		await ctx.db.patch(args.rowId, patch);
		return { ok: true };
	}
});

export const pruneDetailRefreshQueue = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
		const rows = await ctx.db.query('detailRefreshQueue').collect();
		let deleted = 0;
		const idleCutoff = args.now - 120 * 24 * 60 * 60_000;
		const errorCutoff = args.now - 45 * 24 * 60 * 60_000;
		for (const row of rows) {
			if (deleted >= limit) break;
			if (row.state === 'running' || row.state === 'queued' || row.state === 'retry') continue;
			if (row.state === 'idle' && (row.lastSuccessAt ?? 0) > idleCutoff) continue;
			if (row.state === 'error' && (row.lastFinishedAt ?? 0) > errorCutoff) continue;
			await ctx.db.delete(row._id);
			deleted += 1;
		}
		return { deleted };
	}
});

export const listDetailRefreshQueue = internalQuery({
	args: {
		state: v.optional(
			v.union(
				v.literal('idle'),
				v.literal('queued'),
				v.literal('running'),
				v.literal('retry'),
				v.literal('error')
			)
		),
		maxItems: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const maxItems = Math.max(1, Math.min(args.maxItems ?? 200, 500));
		const rows = await ctx.db.query('detailRefreshQueue').collect();
		const filtered = args.state ? rows.filter((row) => row.state === args.state) : rows;
		const items = filtered
			.sort((a, b) => (b.lastRequestedAt ?? 0) - (a.lastRequestedAt ?? 0))
			.slice(0, maxItems);
		return { items, total: items.length };
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
		force: v.optional(v.boolean()),
		skipQueueUpsert: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<RefreshIfStaleResult> => {
		const source = (args.source ?? 'tmdb') as MediaSource;
		const tmdbNumericId = source === 'tmdb' ? parseNumericTMDBId(args.id) : null;
		const shouldUpsertQueueRow = args.skipQueueUpsert !== true && tmdbNumericId != null;
		if (shouldUpsertQueueRow) {
			await ctx.runMutation(internal.detailsRefresh.upsertDetailRefreshQueueRequest, {
				mediaType: args.mediaType,
				source: 'tmdb',
				externalId: tmdbNumericId as number,
				priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
				now: Date.now(),
				force: args.force
			});
		}

		const result = await runRefreshIfStale(
			ctx,
			{
				mediaType: args.mediaType,
				id: args.id,
				source: args.source,
				force: args.force
			},
			DETAIL_REFRESH_CONFIG
		);

		const shouldCheckAnimeEnrichment = tmdbNumericId != null;

		if (shouldCheckAnimeEnrichment) {
			const tmdbId = tmdbNumericId as number;
			const animeEnqueueStatus = (await ctx.runQuery(
				internal.anime.getAnimePickerEnqueueStatusByTMDB,
				{
					tmdbType: args.mediaType,
					tmdbId,
					now: Date.now()
				}
			)) as {
				found: boolean;
				isAnime: boolean | null;
				shouldEnqueue: boolean;
			};
			if (animeEnqueueStatus.isAnime !== true || animeEnqueueStatus.shouldEnqueue !== true) {
				return result;
			}

			try {
				await ctx.scheduler.runAfter(0, api.anime.requestPickerRefreshForTMDB, {
					tmdbType: args.mediaType,
					tmdbId
				});
			} catch (error) {
				// Detail refresh is primary; anime enrichment is best-effort.
				console.warn('[detailsRefresh] anime sync failed after refreshIfStale', {
					tmdbType: args.mediaType,
					tmdbId,
					error
				});
			}
		}

		return result;
	}
});

export const sweepStaleDetails = internalAction({
	args: {},
	handler: async (ctx): Promise<SweepStaleDetailsResult> => {
		const enqueueResult = await ctx.runAction(
			internal.detailsRefresh.enqueueStaleDetailRefreshQueueJobs,
			{
				now: Date.now(),
				limit: 200,
				limitPerType: DETAIL_REFRESH_CONFIG.scanPerType,
				priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY
			}
		);
		const processResult = await ctx.runAction(internal.detailsRefresh.processDetailRefreshQueue, {
			maxJobs: DETAIL_REFRESH_CONFIG.maxRefreshes
		});
		return {
			scanned: (enqueueResult as { scanned?: number }).scanned ?? 0,
			selected: (enqueueResult as { queued?: number }).queued ?? 0,
			refreshed: (processResult as { refreshed?: number }).refreshed ?? 0,
			skipped: (processResult as { skipped?: number }).skipped ?? 0,
			failed: (processResult as { failed?: number }).failed ?? 0
		};
	}
});

export const requestDetailRefreshForTMDB = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const result = await ctx.runMutation(internal.detailsRefresh.upsertDetailRefreshQueueRequest, {
			mediaType: args.mediaType,
			source: 'tmdb',
			externalId: args.id,
			priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
			now: Date.now(),
			force: args.force
		});
		try {
			await ctx.scheduler.runAfter(0, internal.detailsRefresh.processDetailRefreshQueue, {
				maxJobs: 3
			});
		} catch (error) {
			console.warn('[detailsRefresh] failed to schedule detail refresh queue processor', {
				mediaType: args.mediaType,
				id: args.id,
				error
			});
		}
		return result;
	}
});

export const enqueueStaleDetailRefreshes = internalAction({
	args: {
		limit: v.optional(v.number()),
		limitPerType: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		return await ctx.runAction(internal.detailsRefresh.enqueueStaleDetailRefreshQueueJobs, {
			now: Date.now(),
			limit: args.limit ?? 200,
			limitPerType: args.limitPerType ?? 150,
			priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY
		});
	}
});

export const processDetailRefreshQueue = internalAction({
	args: {
		maxJobs: v.optional(v.number()),
		mediaType: v.optional(mediaTypeValidator)
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const maxJobs = Math.max(1, Math.min(args.maxJobs ?? 6, 20));
		await ctx.runMutation(internal.detailsRefresh.pruneExpiredRefreshLeases, {
			now,
			limit: DETAIL_REFRESH_CONFIG.pruneLimit
		});
		await ctx.runMutation(internal.detailsRefresh.pruneDetailRefreshQueue, {
			now,
			limit: 200
		});
		await ctx.runAction(internal.detailsRefresh.enqueueStaleDetailRefreshQueueJobs, {
			now,
			limit: 100,
			limitPerType: DETAIL_REFRESH_CONFIG.scanPerType,
			priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY
		});

		let processed = 0;
		let refreshed = 0;
		let skipped = 0;
		let failed = 0;
		let deferred = 0;

		for (let index = 0; index < maxJobs; index += 1) {
			const claim = await ctx.runMutation(internal.detailsRefresh.claimNextDetailRefreshQueueJob, {
				now: Date.now(),
				mediaType: args.mediaType
			});
			if (!claim) break;
			processed += 1;
			try {
				const result = (await ctx.runAction(api.detailsRefresh.refreshIfStale, {
					mediaType: claim.mediaType,
					id: claim.externalId,
					source: claim.source,
					force: false,
					skipQueueUpsert: true
				})) as RefreshIfStaleResult;
				if (result.refreshed) {
					refreshed += 1;
					await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
						rowId: claim._id,
						now: Date.now(),
						outcome: 'success',
						nextRefreshAt:
							result.nextRefreshAt ?? Date.now() + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
						lastResultStatus: result.reason
					});
					continue;
				}
				if (result.reason === 'in-flight') {
					deferred += 1;
					await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
						rowId: claim._id,
						now: Date.now(),
						outcome: 'retry',
						nextAttemptAt: Date.now() + DETAIL_REFRESH_QUEUE_BUSY_RETRY_MS,
						lastError: 'detail refresh already in flight',
						lastResultStatus: result.reason
					});
					continue;
				}
				skipped += 1;
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: 'success',
					nextRefreshAt:
						result.nextRefreshAt ?? Date.now() + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
					lastResultStatus: result.reason
				});
			} catch (error) {
				failed += 1;
				const errorMessage = error instanceof Error ? error.message : String(error);
				const backoffMs = computeRefreshErrorBackoffMs(Math.max(1, claim.attemptCount ?? 1));
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: 'retry',
					nextAttemptAt: Date.now() + backoffMs,
					lastError: errorMessage.slice(0, 500),
					lastResultStatus: 'failed'
				});
			}
		}

		return { ok: true, processed, refreshed, skipped, failed, deferred };
	}
});
