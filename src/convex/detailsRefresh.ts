import type {
	ProcessQueueResult,
	QueueUpsertResult
} from './services/detailsRefresh/resultParsers';
import type { RefreshIfStaleResult, SweepStaleDetailsResult } from './types/detailsType';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import {
	DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY,
	DETAIL_REFRESH_QUEUE_BUSY_RETRY_MS,
	DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
	DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY
} from './services/detailsRefresh/constants';
import {
	getStoredMediaHandler,
	insertMediaHandler,
	recordRefreshFailureHandler
} from './services/detailsRefresh/mediaHandlers';
import {
	claimNextDetailRefreshQueueJobHandler,
	enqueueStaleDetailRefreshQueueJobsHandler,
	finishDetailRefreshQueueJobHandler,
	listDetailRefreshQueueHandler,
	listStaleRefreshCandidatesHandler,
	pruneDetailRefreshQueueHandler,
	pruneExpiredRefreshLeasesHandler,
	releaseRefreshLeaseHandler,
	tryAcquireRefreshLeaseHandler,
	upsertDetailRefreshQueueRequestHandler
} from './services/detailsRefresh/queueHandlers';
import {
	isQueueUpsertResult,
	toAnimeSeasonEnqueueStatus,
	toProcessQueueSummary,
	toQueueSweepSummary,
	toRefreshIfStaleResult
} from './services/detailsRefresh/resultParsers';
import {
	computeRefreshErrorBackoffMs,
	DEFAULT_DETAIL_REFRESH_CONFIG,
	runRefreshIfStale
} from './services/detailsRefreshService';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;

const DETAIL_REFRESH_CONFIG = {
	detailSchemaVersion: DETAIL_SCHEMA_VERSION,
	...DEFAULT_DETAIL_REFRESH_CONFIG
} as const;

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
const detailSeasonValidator = v.object({
	id: v.number(),
	name: v.string(),
	overview: v.union(v.string(), v.null()),
	airDate: v.union(v.string(), v.null()),
	episodeCount: v.union(v.number(), v.null()),
	posterPath: v.union(v.string(), v.null()),
	seasonNumber: v.number(),
	voteAverage: v.union(v.number(), v.null())
});

function parseNumericTMDBId(id: number | string): number | null {
	if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id) && id > 0) return id;
	if (typeof id !== 'string') return null;
	const trimmed = id.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: getStoredMediaHandler
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
		seasons: v.optional(v.union(v.array(detailSeasonValidator), v.null())),
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
	handler: insertMediaHandler
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
	handler: tryAcquireRefreshLeaseHandler
});

export const releaseRefreshLease = internalMutation({
	args: {
		leaseId: v.id('detailRefreshLeases'),
		owner: v.string()
	},
	handler: releaseRefreshLeaseHandler
});

export const pruneExpiredRefreshLeases = internalMutation({
	args: {
		now: v.number(),
		limit: v.number()
	},
	handler: pruneExpiredRefreshLeasesHandler
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
	handler: upsertDetailRefreshQueueRequestHandler
});

export const enqueueStaleDetailRefreshQueueJobs: ReturnType<typeof internalAction> = internalAction(
	{
		args: {
			now: v.number(),
			limit: v.optional(v.number()),
			limitPerType: v.optional(v.number()),
			priority: v.optional(v.number())
		},
		handler: enqueueStaleDetailRefreshQueueJobsHandler
	}
);

export const claimNextDetailRefreshQueueJob = internalMutation({
	args: {
		now: v.number(),
		mediaType: v.optional(mediaTypeValidator)
	},
	handler: claimNextDetailRefreshQueueJobHandler
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
	handler: finishDetailRefreshQueueJobHandler
});

export const pruneDetailRefreshQueue = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: pruneDetailRefreshQueueHandler
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
		maxItems: v.optional(v.number()),
		includeTotal: v.optional(v.boolean())
	},
	handler: listDetailRefreshQueueHandler
});

export const listStaleRefreshCandidates = internalQuery({
	args: {
		now: v.number(),
		limitPerType: v.number()
	},
	handler: listStaleRefreshCandidatesHandler
});

export const recordRefreshFailure = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		failedAt: v.number()
	},
	handler: recordRefreshFailureHandler
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
		const source = args.source ?? 'tmdb';
		const tmdbNumericId = source === 'tmdb' ? parseNumericTMDBId(args.id) : null;
		const shouldUpsertQueueRow = args.skipQueueUpsert !== true && tmdbNumericId != null;
		const now = Date.now();
		if (shouldUpsertQueueRow) {
			const externalId = tmdbNumericId;
			await ctx.runMutation(internal.detailsRefresh.upsertDetailRefreshQueueRequest, {
				mediaType: args.mediaType,
				source: 'tmdb',
				externalId,
				priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
				now,
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
			const tmdbId = tmdbNumericId;
			const rawAnimeEnqueueStatus = await ctx.runQuery(
				internal.animeSync.getAnimeSeasonEnqueueStatusByTMDB,
				{
					tmdbType: args.mediaType,
					tmdbId,
					now
				}
			);
			const animeEnqueueStatus = toAnimeSeasonEnqueueStatus(rawAnimeEnqueueStatus);
			if (animeEnqueueStatus.isAnime !== true || animeEnqueueStatus.shouldEnqueue !== true) {
				return result;
			}

			try {
				await ctx.scheduler.runAfter(0, api.animeSync.requestSeasonRefreshForTMDB, {
					tmdbType: args.mediaType,
					tmdbId
				});
			} catch (error) {
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
		const process = toProcessQueueSummary(processResult);
		const enqueue = toQueueSweepSummary(enqueueResult);
		return {
			scanned: enqueue.scanned,
			selected: enqueue.queued,
			refreshed: process.refreshed,
			skipped: process.skipped,
			failed: process.failed
		};
	}
});

export const requestDetailRefreshForTMDB = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<QueueUpsertResult> => {
		const now = Date.now();
		const rawResult = await ctx.runMutation(
			internal.detailsRefresh.upsertDetailRefreshQueueRequest,
			{
				mediaType: args.mediaType,
				source: 'tmdb',
				externalId: args.id,
				priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
				now,
				force: args.force
			}
		);
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
		if (!isQueueUpsertResult(rawResult)) {
			throw new Error('Invalid queue upsert result');
		}
		return rawResult;
	}
});

export const enqueueStaleDetailRefreshes = internalAction({
	args: {
		limit: v.optional(v.number()),
		limitPerType: v.optional(v.number())
	},
	handler: async (ctx, args): Promise<{ scanned: number; queued: number }> => {
		const raw = await ctx.runAction(internal.detailsRefresh.enqueueStaleDetailRefreshQueueJobs, {
			now: Date.now(),
			limit: args.limit ?? 200,
			limitPerType: args.limitPerType ?? 150,
			priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY
		});
		return toQueueSweepSummary(raw);
	}
});

export const processDetailRefreshQueue = internalAction({
	args: {
		maxJobs: v.optional(v.number()),
		mediaType: v.optional(mediaTypeValidator)
	},
	handler: async (ctx, args): Promise<ProcessQueueResult> => {
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
			const loopNow = Date.now();
			const claim = await ctx.runMutation(internal.detailsRefresh.claimNextDetailRefreshQueueJob, {
				now: loopNow,
				mediaType: args.mediaType
			});
			if (!claim) break;
			processed += 1;
			try {
				const rawResult = await ctx.runAction(api.detailsRefresh.refreshIfStale, {
					mediaType: claim.mediaType,
					id: claim.externalId,
					source: claim.source,
					force: false,
					skipQueueUpsert: true
				});
				const result = toRefreshIfStaleResult(rawResult);
				if (result.refreshed) {
					refreshed += 1;
					await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
						rowId: claim._id,
						now: loopNow,
						outcome: 'success',
						nextRefreshAt:
							result.nextRefreshAt ?? loopNow + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
						lastResultStatus: result.reason
					});
					continue;
				}
				if (result.reason === 'in-flight') {
					deferred += 1;
					await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
						rowId: claim._id,
						now: loopNow,
						outcome: 'retry',
						nextAttemptAt: loopNow + DETAIL_REFRESH_QUEUE_BUSY_RETRY_MS,
						lastError: 'detail refresh already in flight',
						lastResultStatus: result.reason
					});
					continue;
				}
				skipped += 1;
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: loopNow,
					outcome: 'success',
					nextRefreshAt:
						result.nextRefreshAt ?? loopNow + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
					lastResultStatus: result.reason
				});
			} catch (error) {
				failed += 1;
				const errorMessage = error instanceof Error ? error.message : String(error);
				const backoffMs = computeRefreshErrorBackoffMs(Math.max(1, claim.attemptCount ?? 1));
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: loopNow,
					outcome: 'retry',
					nextAttemptAt: loopNow + backoffMs,
					lastError: errorMessage.slice(0, 500),
					lastResultStatus: 'failed'
				});
			}
		}

		return { ok: true, processed, refreshed, skipped, failed, deferred };
	}
});
