import type { Id } from './_generated/dataModel';
import type { ActionCtx, MutationCtx } from './_generated/server';
import type {
	ProcessQueueResult,
	QueueUpsertResult
} from './services/detailsRefresh/resultParsers';
import type { RefreshIfStaleResult } from './types/detailsType';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation
} from './_generated/server';
import {
	DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
	DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY
} from './services/detailsRefresh/constants';
import {
	getCreditCacheBySourceHandler,
	upsertCreditCacheHandler
} from './services/detailsRefresh/creditCacheHandlers';
import {
	backfillMissingDetailRefreshQueueRowsPageHandler,
	getCreditCacheRepairPageHandler,
	getDetailRefreshQueueRepairPageHandler,
	repairCreditCachePageHandler,
	repairDetailRefreshQueuePageHandler
} from './services/detailsRefresh/maintenanceHandlers';
import {
	getStoredMediaHandler,
	insertMediaHandler,
	recordRefreshFailureHandler
} from './services/detailsRefresh/mediaHandlers';
import {
	claimDetailRefreshQueueJobsHandler,
	finalizeDetailRefreshWorkerRunHandler,
	finishDetailRefreshQueueJobHandler,
	listDetailRefreshQueueHandler,
	markDetailRefreshWorkerFinishedHandler,
	markDetailRefreshWorkerStartedHandler,
	pruneDetailRefreshQueueHandler,
	scheduleDetailRefreshWorkerIfNeededHandler,
	syncDetailRefreshQueueRowHandler,
	upsertDetailRefreshQueueRequestHandler
} from './services/detailsRefresh/queueHandlers';
import {
	isQueueUpsertResult,
	toAnimeSeasonEnqueueStatus
} from './services/detailsRefresh/resultParsers';
import { getDetailRefreshSnapshotHandler } from './services/detailsRefresh/snapshotHandlers';
import {
	computeRefreshErrorBackoffMs,
	DEFAULT_DETAIL_REFRESH_CONFIG,
	runRefreshIfStale
} from './services/detailsRefreshService';
import { getMovieBySource, getTVShowBySource } from './utils/mediaLookup';

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
const detailPayloadValidator = v.object({
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
});
const creditCachePayloadValidator = v.object({
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
});

type BackfillDetailRefreshQueuePageResult = {
	scanned: number;
	created: number;
	cursor: string | null;
	isDone: boolean;
};

type RepairPageItem<TRowId> = {
	rowId: TRowId;
	key: string;
};
type DetailRefreshRequestArgs = {
	mediaType: 'movie' | 'tv';
	id: number | string;
	source?: 'tmdb' | 'trakt' | 'imdb';
	force?: boolean;
	skipQueueUpsert?: boolean;
	skipDetailRefresh?: boolean;
	creditCoverageTarget?: 'preview' | 'full';
	creditSeasonContext?: { seasonKey: string; tmdbSeasonNumber?: number | null } | null;
	skipExecutionRecheck?: boolean;
};
type RepairPageResult<TRowId> = {
	items: Array<RepairPageItem<TRowId>>;
	cursor: string | null;
	isDone: boolean;
};
type RepairMutationResult = {
	rowsDeleted: number;
	rowsPatched: number;
};

function splitRepairPageItems<TRowId>(
	items: RepairPageItem<TRowId>[],
	isDone: boolean
): {
	readyRowIds: TRowId[];
	pendingItems: RepairPageItem<TRowId>[];
} {
	if (items.length === 0) {
		return { readyRowIds: [], pendingItems: [] };
	}
	if (isDone) {
		return {
			readyRowIds: items.map((item) => item.rowId),
			pendingItems: []
		};
	}
	const trailingKey = items[items.length - 1]?.key;
	if (!trailingKey) {
		return {
			readyRowIds: items.map((item) => item.rowId),
			pendingItems: []
		};
	}
	let splitIndex = items.length;
	while (splitIndex > 0 && items[splitIndex - 1]?.key === trailingKey) {
		splitIndex -= 1;
	}
	return {
		readyRowIds: items.slice(0, splitIndex).map((item) => item.rowId),
		pendingItems: items.slice(splitIndex)
	};
}

function parseNumericTMDBId(id: number | string): number | null {
	if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id) && id > 0) return id;
	if (typeof id !== 'string') return null;
	const trimmed = id.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRefreshRequestId(
	source: DetailRefreshRequestArgs['source'],
	id: DetailRefreshRequestArgs['id']
): number | string {
	if ((source ?? 'tmdb') !== 'tmdb') {
		return id;
	}
	return parseNumericTMDBId(id) ?? id;
}

async function scheduleQueuedDetailRefresh(
	ctx: MutationCtx,
	args: {
		now: number;
		queueResult: QueueUpsertResult;
		mediaType: 'movie' | 'tv';
		id: number;
		warningMessage: string;
	}
): Promise<void> {
	if (!args.queueResult.queued) {
		return;
	}

	try {
		await scheduleDetailRefreshWorkerIfNeededHandler(ctx, {
			now: args.now,
			maxJobs: 1,
			preferredRowId: args.queueResult.rowId
		});
	} catch (error) {
		console.warn(args.warningMessage, {
			mediaType: args.mediaType,
			id: args.id,
			error
		});
	}
}

async function processRepairPages<TRowId>(
	loadPage: (cursor: string | null) => Promise<RepairPageResult<TRowId>>,
	repairRows: (rowIds: TRowId[]) => Promise<RepairMutationResult>
): Promise<RepairMutationResult> {
	let cursor: string | null = null;
	let pendingItems: Array<RepairPageItem<TRowId>> = [];
	let rowsDeleted = 0;
	let rowsPatched = 0;
	let isDone = false;

	while (!isDone) {
		const page = await loadPage(cursor);
		const combinedItems = [...pendingItems, ...page.items];
		const split = splitRepairPageItems(combinedItems, page.isDone);
		if (split.readyRowIds.length > 0) {
			const result = await repairRows(split.readyRowIds);
			rowsDeleted += result.rowsDeleted;
			rowsPatched += result.rowsPatched;
		}
		pendingItems = split.pendingItems;
		cursor = page.cursor;
		isDone = page.isDone;
	}

	if (pendingItems.length > 0) {
		const result = await repairRows(pendingItems.map((item) => item.rowId));
		rowsDeleted += result.rowsDeleted;
		rowsPatched += result.rowsPatched;
	}

	return { rowsDeleted, rowsPatched };
}

async function finishClaimedDetailRefreshQueueJob(
	ctx: ActionCtx,
	args: {
		rowId: Id<'detailRefreshQueue'>;
		now: number;
		result: RefreshIfStaleResult;
	}
): Promise<void> {
	await ctx.runMutation(internal.detailsRefresh.finishDetailRefreshQueueJob, {
		rowId: args.rowId,
		now: args.now,
		outcome: 'success',
		nextRefreshAt:
			args.result.nextRefreshAt ?? args.now + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
		lastResultStatus: args.result.reason
	});
}

async function runDetailRefreshRequest(
	ctx: ActionCtx,
	args: DetailRefreshRequestArgs
): Promise<RefreshIfStaleResult> {
	const source = args.source ?? 'tmdb';
	const normalizedId = normalizeRefreshRequestId(source, args.id);
	const tmdbNumericId = source === 'tmdb' ? parseNumericTMDBId(normalizedId) : null;
	const effectiveSkipDetailRefresh = args.skipDetailRefresh === true;
	const now = Date.now();

	try {
		const result = await runRefreshIfStale(
			ctx,
			{
				mediaType: args.mediaType,
				id: normalizedId,
				source,
				force: args.force,
				skipDetailRefresh: effectiveSkipDetailRefresh,
				creditCoverageTarget: args.creditCoverageTarget,
				creditSeasonContext: args.creditSeasonContext ?? null
			},
			{
				...DETAIL_REFRESH_CONFIG,
				skipExecutionRecheck: args.skipExecutionRecheck === true
			}
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
				nextRefreshAt:
					result.nextRefreshAt ?? syncNow + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS,
				lastResultStatus: result.reason
			});
		}

		const shouldCheckAnimeEnrichment =
			tmdbNumericId != null && effectiveSkipDetailRefresh === false && result.refreshed === true;
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
	args: detailPayloadValidator,
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
	args: creditCachePayloadValidator,
	handler: upsertCreditCacheHandler
});

export const persistDetailRefreshArtifacts = internalMutation({
	args: {
		detail: v.optional(detailPayloadValidator),
		creditCache: v.optional(creditCachePayloadValidator)
	},
	handler: async (ctx, args) => {
		if (!args.detail && !args.creditCache) {
			return { ok: true, persistedDetail: false, persistedCreditCache: false };
		}
		if (args.detail) {
			await insertMediaHandler(ctx, args.detail);
		}
		if (args.creditCache) {
			await upsertCreditCacheHandler(ctx, args.creditCache);
		}
		return {
			ok: true,
			persistedDetail: args.detail != null,
			persistedCreditCache: args.creditCache != null
		};
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
	handler: upsertDetailRefreshQueueRequestHandler
});

export const claimDetailRefreshQueueJobs = internalMutation({
	args: {
		now: v.number(),
		maxJobs: v.number(),
		mediaType: v.optional(mediaTypeValidator),
		preferredRowId: v.optional(v.id('detailRefreshQueue')),
		activeTtlMs: v.optional(v.number())
	},
	handler: claimDetailRefreshQueueJobsHandler
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

export const finalizeDetailRefreshWorkerRun = internalMutation({
	args: {
		now: v.number(),
		maxJobs: v.number(),
		shouldContinueProcessing: v.boolean(),
		preferredRowId: v.optional(v.id('detailRefreshQueue')),
		delayMs: v.optional(v.number()),
		activeTtlMs: v.optional(v.number())
	},
	handler: finalizeDetailRefreshWorkerRunHandler
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

export const scheduleDetailRefreshWorkerIfNeeded = internalMutation({
	args: {
		now: v.number(),
		maxJobs: v.number(),
		delayMs: v.optional(v.number()),
		activeTtlMs: v.optional(v.number()),
		preferredRowId: v.optional(v.id('detailRefreshQueue'))
	},
	handler: scheduleDetailRefreshWorkerIfNeededHandler
});

export const markDetailRefreshWorkerStarted = internalMutation({
	args: {
		now: v.number(),
		activeTtlMs: v.optional(v.number())
	},
	handler: markDetailRefreshWorkerStartedHandler
});

export const markDetailRefreshWorkerFinished = internalMutation({
	args: {
		now: v.number()
	},
	handler: markDetailRefreshWorkerFinishedHandler
});

export const pruneDetailRefreshQueue = internalMutation({
	args: {
		now: v.optional(v.number()),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) =>
		pruneDetailRefreshQueueHandler(ctx, {
			now: args.now ?? Date.now(),
			limit: args.limit
		})
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

export const getDetailRefreshQueueRepairPage = internalQuery({
	args: {
		limit: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: getDetailRefreshQueueRepairPageHandler
});

export const repairDetailRefreshQueuePage = internalMutation({
	args: {
		rowIds: v.array(v.id('detailRefreshQueue')),
		now: v.number()
	},
	handler: repairDetailRefreshQueuePageHandler
});

export const getCreditCacheRepairPage = internalQuery({
	args: {
		limit: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: getCreditCacheRepairPageHandler
});

export const repairCreditCachePage = internalMutation({
	args: {
		rowIds: v.array(v.id('creditCache'))
	},
	handler: repairCreditCachePageHandler
});

export const repairDetailRefreshArtifacts = internalAction({
	args: {
		now: v.optional(v.number()),
		pageSize: v.optional(v.number())
	},
	handler: async (
		ctx,
		args
	): Promise<{
		queueRowsDeleted: number;
		queueRowsPatched: number;
		creditRowsDeleted: number;
		creditRowsPatched: number;
	}> => {
		const now = args.now ?? Date.now();
		const pageSize = Math.max(50, Math.min(args.pageSize ?? 250, 500));
		const { rowsDeleted: queueRowsDeleted, rowsPatched: queueRowsPatched } =
			await processRepairPages<Id<'detailRefreshQueue'>>(
				(cursor) =>
					ctx.runQuery(internal.detailsRefresh.getDetailRefreshQueueRepairPage, {
						limit: pageSize,
						cursor
					}),
				(rowIds) =>
					ctx.runMutation(internal.detailsRefresh.repairDetailRefreshQueuePage, {
						rowIds,
						now
					})
			);
		const { rowsDeleted: creditRowsDeleted, rowsPatched: creditRowsPatched } =
			await processRepairPages<Id<'creditCache'>>(
				(cursor) =>
					ctx.runQuery(internal.detailsRefresh.getCreditCacheRepairPage, {
						limit: pageSize,
						cursor
					}),
				(rowIds) =>
					ctx.runMutation(internal.detailsRefresh.repairCreditCachePage, {
						rowIds
					})
			);

		return {
			queueRowsDeleted,
			queueRowsPatched,
			creditRowsDeleted,
			creditRowsPatched
		};
	}
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
		await scheduleQueuedDetailRefresh(ctx, {
			now,
			queueResult: rawResult,
			mediaType: args.mediaType,
			id: args.id,
			warningMessage: '[detailsRefresh] failed to schedule detail refresh queue processor'
		});
		return rawResult;
	}
});

export const ensureDetailMaterializedOrQueue = mutation({
	args: {
		mediaType: mediaTypeValidator,
		id: v.number()
	},
	handler: async (ctx, args) => {
		const existing =
			args.mediaType === 'movie'
				? await getMovieBySource(ctx, 'tmdb', args.id)
				: await getTVShowBySource(ctx, 'tmdb', args.id);
		if (existing) {
			return {
				exists: true,
				queued: false,
				inserted: false
			};
		}

		const now = Date.now();
		const rawResult = await upsertDetailRefreshQueueRequestHandler(ctx, {
			mediaType: args.mediaType,
			source: 'tmdb',
			externalId: args.id,
			priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
			now
		});
		if (!isQueueUpsertResult(rawResult)) {
			throw new Error('Invalid queue upsert result');
		}
		await scheduleQueuedDetailRefresh(ctx, {
			now,
			queueResult: rawResult,
			mediaType: args.mediaType,
			id: args.id,
			warningMessage: '[detailsRefresh] failed to schedule detail materialization queue processor'
		});
		return {
			exists: false,
			queued: rawResult.queued,
			inserted: rawResult.inserted
		};
	}
});

export const processDetailRefreshQueue = internalAction({
	args: {
		maxJobs: v.optional(v.number()),
		mediaType: v.optional(mediaTypeValidator),
		preferredRowId: v.optional(v.id('detailRefreshQueue'))
	},
	handler: async (ctx, args): Promise<ProcessQueueResult> => {
		const now = Date.now();
		const maxJobs = Math.max(1, Math.min(args.maxJobs ?? 6, 20));

		let processed = 0;
		let refreshed = 0;
		let skipped = 0;
		let failed = 0;
		let shouldContinueProcessing = false;

		try {
			const claims = await ctx.runMutation(internal.detailsRefresh.claimDetailRefreshQueueJobs, {
				now,
				maxJobs,
				mediaType: args.mediaType,
				preferredRowId: args.preferredRowId
			});

			for (const claim of claims) {
				processed += 1;
				try {
					const result = await runDetailRefreshRequest(ctx, {
						mediaType: claim.mediaType,
						id: claim.externalId,
						source: claim.source,
						force: claim.forceRefresh === true,
						skipQueueUpsert: true,
						creditCoverageTarget: 'full',
						skipExecutionRecheck: true
					});
					if (result.refreshed) {
						refreshed += 1;
						await finishClaimedDetailRefreshQueueJob(ctx, {
							rowId: claim._id,
							now: Date.now(),
							result
						});
						continue;
					}
					skipped += 1;
					await finishClaimedDetailRefreshQueueJob(ctx, {
						rowId: claim._id,
						now: Date.now(),
						result
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
			shouldContinueProcessing = args.preferredRowId == null && claims.length >= maxJobs;
		} finally {
			await ctx.runMutation(internal.detailsRefresh.finalizeDetailRefreshWorkerRun, {
				now: Date.now(),
				maxJobs,
				shouldContinueProcessing,
				preferredRowId: args.preferredRowId
			});
		}

		const result = { ok: true, processed, refreshed, skipped, failed, deferred: 0 };
		return result;
	}
});
