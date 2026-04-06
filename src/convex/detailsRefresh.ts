import type {
	ProcessQueueResult,
	QueueUpsertResult
} from './services/detailsRefresh/resultParsers';
import type { ActionCtx } from './_generated/server';
import type { RefreshIfStaleResult } from './types/detailsType';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery, mutation } from './_generated/server';
import {
	DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
	DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY
} from './services/detailsRefresh/constants';
import {
	getCreditCacheBySourceHandler,
	upsertCreditCacheHandler
} from './services/detailsRefresh/creditCacheHandlers';
import {
	getStoredMediaHandler,
	insertMediaHandler,
	recordRefreshFailureHandler
} from './services/detailsRefresh/mediaHandlers';
import { getDetailRefreshSnapshotHandler } from './services/detailsRefresh/snapshotHandlers';
import {
	backfillMissingDetailRefreshQueueRowsPageHandler,
	repairDetailRefreshArtifactsHandler
} from './services/detailsRefresh/maintenanceHandlers';
import {
	claimNextDetailRefreshQueueJobHandler,
	finishDetailRefreshQueueJobHandler,
	listDetailRefreshQueueHandler,
	pruneDetailRefreshQueueHandler,
	syncDetailRefreshQueueRowHandler,
	upsertDetailRefreshQueueRequestHandler
} from './services/detailsRefresh/queueHandlers';
import {
	isQueueUpsertResult,
	toAnimeSeasonEnqueueStatus
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
const detailCastCreditValidator = v.object({
	id: v.number(),
	adult: v.boolean(),
	gender: v.number(),
	knownForDepartment: v.string(),
	name: v.string(),
	originalName: v.string(),
	popularity: v.number(),
	profilePath: v.union(v.string(), v.null()),
	character: v.string(),
	creditId: v.string(),
	order: v.number(),
	castId: v.optional(v.union(v.number(), v.null()))
});
const detailCrewCreditValidator = v.object({
	id: v.number(),
	adult: v.boolean(),
	gender: v.number(),
	knownForDepartment: v.string(),
	name: v.string(),
	originalName: v.string(),
	popularity: v.number(),
	profilePath: v.union(v.string(), v.null()),
	creditId: v.string(),
	department: v.string(),
	job: v.string()
});
const creditSourceValidator = v.union(v.literal('tmdb'), v.literal('anilist'));
const creditCoverageValidator = v.union(v.literal('preview'), v.literal('full'));
const creditSeasonContextValidator = v.object({
	seasonKey: v.string(),
	tmdbSeasonNumber: v.optional(v.union(v.number(), v.null()))
});

type BackfillDetailRefreshQueuePageResult = {
	scanned: number;
	created: number;
	cursor: string | null;
	isDone: boolean;
};

function parseNumericTMDBId(id: number | string): number | null {
	if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id) && id > 0) return id;
	if (typeof id !== 'string') return null;
	const trimmed = id.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function runDetailRefreshRequest(
	ctx: ActionCtx,
	args: {
		mediaType: 'movie' | 'tv';
		id: number | string;
		source?: 'tmdb' | 'trakt' | 'imdb';
		force?: boolean;
		skipQueueUpsert?: boolean;
		skipDetailRefresh?: boolean;
		creditCoverageTarget?: 'preview' | 'full';
		creditSeasonContext?: { seasonKey: string; tmdbSeasonNumber?: number | null } | null;
	}
): Promise<RefreshIfStaleResult> {
	const source = args.source ?? 'tmdb';
	const tmdbNumericId = source === 'tmdb' ? parseNumericTMDBId(args.id) : null;
	const effectiveSkipDetailRefresh = args.skipDetailRefresh === true;
	const now = Date.now();

	try {
		const result = await runRefreshIfStale(
			ctx,
			{
				mediaType: args.mediaType,
				id: args.id,
				source: args.source,
				force: args.force,
				skipDetailRefresh: effectiveSkipDetailRefresh,
				creditCoverageTarget: args.creditCoverageTarget,
				creditSeasonContext: args.creditSeasonContext ?? null
			},
			DETAIL_REFRESH_CONFIG
		);

		const shouldSyncQueueRow =
			tmdbNumericId != null &&
			args.skipQueueUpsert !== true &&
			effectiveSkipDetailRefresh === false;
		if (shouldSyncQueueRow) {
			const syncNow = Date.now();
			await ctx.runMutation(internal.detailsRefresh.syncDetailRefreshQueueRow, {
				mediaType: args.mediaType,
				source: 'tmdb',
				externalId: tmdbNumericId,
				now: syncNow,
				outcome: 'success',
				nextRefreshAt: result.nextRefreshAt ?? syncNow + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
				lastResultStatus: result.reason
			});
		}

		const shouldCheckAnimeEnrichment =
			tmdbNumericId != null && effectiveSkipDetailRefresh === false;
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
			if (animeEnqueueStatus.isAnime === true && animeEnqueueStatus.shouldEnqueue === true) {
				try {
					await ctx.scheduler.runAfter(0, api.animeSync.requestSeasonRefreshForTMDB, {
						tmdbType: args.mediaType,
						tmdbId
					});
				} catch (error) {
					console.warn('[detailsRefresh] anime sync failed after detail refresh', {
						tmdbType: args.mediaType,
						tmdbId,
						error
					});
				}
			}
		}

		return result;
	} catch (error) {
		if (
			tmdbNumericId != null &&
			args.skipQueueUpsert !== true &&
			effectiveSkipDetailRefresh === false
		) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const failureNow = Date.now();
			await ctx.runMutation(internal.detailsRefresh.syncDetailRefreshQueueRow, {
				mediaType: args.mediaType,
				source: 'tmdb',
				externalId: tmdbNumericId,
				now: failureNow,
				outcome: 'error',
				lastError: errorMessage.slice(0, 500),
				lastResultStatus: 'failed'
			});
		}
		throw error;
	}
}

export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: getStoredMediaHandler
});

export const getDetailRefreshSnapshot = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.number(),
		creditSource: creditSourceValidator,
		seasonKey: v.optional(v.union(v.string(), v.null()))
	},
	handler: getDetailRefreshSnapshotHandler
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

export const getCreditCacheBySource = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		tmdbId: v.number(),
		source: creditSourceValidator,
		seasonKey: v.optional(v.union(v.string(), v.null()))
	},
	handler: getCreditCacheBySourceHandler
});

export const upsertCreditCache = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		tmdbId: v.number(),
		source: creditSourceValidator,
		seasonKey: v.union(v.string(), v.null()),
		coverage: creditCoverageValidator,
		castCredits: v.array(detailCastCreditValidator),
		crewCredits: v.array(detailCrewCreditValidator),
		castTotal: v.number(),
		crewTotal: v.number(),
		fetchedAt: v.number(),
		nextRefreshAt: v.number()
	},
	handler: upsertCreditCacheHandler
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

export const syncDetailRefreshQueueRow = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.number(),
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('retry'), v.literal('error')),
		nextAttemptAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string())
	},
	handler: syncDetailRefreshQueueRowHandler
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

export const backfillMissingDetailRefreshQueueRowsPage = internalMutation({
	args: {
		table: v.union(v.literal('movies'), v.literal('tvShows')),
		now: v.number(),
		limit: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: backfillMissingDetailRefreshQueueRowsPageHandler
});

export const backfillMissingDetailRefreshQueueRows = internalAction({
	args: {
		now: v.optional(v.number()),
		pageSize: v.optional(v.number())
	},
	handler: async (
		ctx,
		args
	): Promise<{
		scanned: number;
		created: number;
	}> => {
		const now = args.now ?? Date.now();
		const pageSize = args.pageSize;
		let scanned = 0;
		let created = 0;

		for (const table of ['movies', 'tvShows'] as const) {
			let cursor: string | null = null;
			let isDone = false;
			while (!isDone) {
				const page: BackfillDetailRefreshQueuePageResult = await ctx.runMutation(
					internal.detailsRefresh.backfillMissingDetailRefreshQueueRowsPage,
					{
						table,
						now,
						limit: pageSize,
						cursor
					}
				);
				scanned += page.scanned;
				created += page.created;
				cursor = page.cursor;
				isDone = page.isDone;
			}
		}

		return { scanned, created };
	}
});

export const repairDetailRefreshArtifacts = internalMutation({
	args: {
		now: v.optional(v.number())
	},
	handler: async (ctx, args) =>
		repairDetailRefreshArtifactsHandler(ctx, { now: args.now ?? Date.now() })
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
		skipQueueUpsert: v.optional(v.boolean()),
		skipDetailRefresh: v.optional(v.boolean()),
		creditCoverageTarget: v.optional(creditCoverageValidator),
		creditSeasonContext: v.optional(v.union(creditSeasonContextValidator, v.null()))
	},
	handler: async (ctx, args): Promise<RefreshIfStaleResult> => {
		const isDirectCreditRefreshRequest =
			args.creditCoverageTarget !== undefined || args.skipDetailRefresh === true;
		if (!isDirectCreditRefreshRequest) {
			throw new Error('Use detailsRefresh:requestDetailRefreshForTMDB for full detail refreshes.');
		}
		return runDetailRefreshRequest(ctx, {
			...args,
			skipDetailRefresh: true
		});
	}
});

export const requestDetailRefreshForTMDB = mutation({
	args: {
		mediaType: mediaTypeValidator,
		id: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<QueueUpsertResult> => {
		const now = Date.now();
		const rawResult = await upsertDetailRefreshQueueRequestHandler(ctx, {
			mediaType: args.mediaType,
			source: 'tmdb',
			externalId: args.id,
			priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
			now,
			force: args.force
		});
		if (!isQueueUpsertResult(rawResult)) {
			throw new Error('Invalid queue upsert result');
		}
		if (rawResult.queued) {
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
		}
		return rawResult;
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
		await ctx.runMutation(internal.detailsRefresh.pruneDetailRefreshQueue, {
			now,
			limit: 200
		});

		let processed = 0;
		let refreshed = 0;
		let skipped = 0;
		let failed = 0;

		for (let index = 0; index < maxJobs; index += 1) {
			const loopNow = Date.now();
			const claim = await ctx.runMutation(internal.detailsRefresh.claimNextDetailRefreshQueueJob, {
				now: loopNow,
				mediaType: args.mediaType
			});
			if (!claim) break;
			processed += 1;
			try {
				const result = await runDetailRefreshRequest(ctx, {
					mediaType: claim.mediaType,
					id: claim.externalId,
					source: claim.source,
					force: claim.forceRefresh === true,
					skipQueueUpsert: true,
					creditCoverageTarget: 'full'
				});
				if (result.refreshed) {
					refreshed += 1;
					const finishedAt = Date.now();
					await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
						rowId: claim._id,
						now: finishedAt,
						outcome: 'success',
						nextRefreshAt:
							result.nextRefreshAt ?? finishedAt + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
						lastResultStatus: result.reason
					});
					continue;
				}
				skipped += 1;
				const finishedAt = Date.now();
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: finishedAt,
					outcome: 'success',
					nextRefreshAt:
						result.nextRefreshAt ?? finishedAt + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
					lastResultStatus: result.reason
				});
			} catch (error) {
				failed += 1;
				const errorMessage = error instanceof Error ? error.message : String(error);
				const failedAt = Date.now();
				const backoffMs = computeRefreshErrorBackoffMs(Math.max(1, claim.attemptCount ?? 1));
				await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
					rowId: claim._id,
					now: failedAt,
					outcome: 'retry',
					nextAttemptAt: failedAt + backoffMs,
					lastError: errorMessage.slice(0, 500),
					lastResultStatus: 'failed'
				});
			}
		}

		return { ok: true, processed, refreshed, skipped, failed, deferred: 0 };
	}
});
