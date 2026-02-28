import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { TVEpisodeRefreshSignals } from './types/animeEpisodeTypes';
import type { StoredAnimeRefreshSignals } from './utils/anime/sync';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { runAnimeSyncWithLease } from './services/anime/animeSyncService';
import { resolveDisplayPlanMode, tmdbTypeValidator } from './utils/anime/domain';
import {
	ANILIST_BASE_BUDGET_PER_MIN,
	animeSeedSweepLeaseKey,
	animeSyncJobDefaultCost,
	animeSyncQueueDefaultPriority,
	animeSyncQueueKey,
	clampAniListThrottleFactor,
	computeAniListBudgetWindow,
	computeAnimeQueueRefreshTtlMs,
	createAnimeSyncLeaseOwner,
	normalizeAniListCost
} from './utils/anime/sync';
import { getFinalMovie, getFinalTV } from './utils/mediaLookup';

const animeSyncJobTypeValidator = v.union(v.literal('season'), v.literal('timeline'));
const animeSeedTableValidator = v.union(v.literal('tvShows'), v.literal('movies'));
const anilistTitleValidator = v.object({
	romaji: v.union(v.string(), v.null()),
	english: v.union(v.string(), v.null()),
	native: v.union(v.string(), v.null())
});
const anilistDateValidator = v.object({
	year: v.union(v.number(), v.null()),
	month: v.union(v.number(), v.null()),
	day: v.union(v.number(), v.null())
});
const anilistStudioValidator = v.object({
	anilistStudioId: v.number(),
	name: v.string(),
	isAnimationStudio: v.optional(v.boolean()),
	isMain: v.optional(v.boolean())
});
const animeXrefCandidateValidator = v.object({
	anilistId: v.number(),
	score: v.number(),
	why: v.optional(v.string())
});
const ANIME_SYNC_QUEUE_FAILURE_RETRY_MS = 5 * 60_000;
const ANIME_SYNC_QUEUE_PRUNE_AGE_MS = 30 * 24 * 60 * 60_000;
const ANIME_QUEUE_SEED_PAGE_SIZE = 200;
const ANIME_QUEUE_SEED_SWEEP_LEASE_TTL_MS = 10 * 60_000;
const ANIME_BUDGET_REFUND_MAX_OBSERVED_COST_FACTOR = 0.7;
const ANIME_COST_DEBUG_LOGS = true;
const ANIME_SEASON_SYNC_LEASE_TTL_MS = 90_000;
const ANIME_TIMELINE_SYNC_LEASE_TTL_MS = 15 * 60_000;
const ANIME_SYNC_QUEUE_INTERACTIVE_SEASON_PRIORITY = 100;
const ANILIST_PROVIDER = 'anilist';
const CLAIMABLE_QUEUE_STATES = ['queued', 'retry'] as const;
const PRUNABLE_QUEUE_STATES = ['error', 'retry', 'idle'] as const;

type AnimeSyncQueueRow = Doc<'animeSyncQueue'>;
type AnimeApiBudgetRow = Doc<'animeApiBudget'>;
type AnimeQueueSeedCandidate = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
};

function isBetterQueueCandidate(
	nextCandidate: AnimeSyncQueueRow,
	currentBest: AnimeSyncQueueRow | null
): boolean {
	if (!currentBest) return true;
	if (nextCandidate.priority !== currentBest.priority) {
		return nextCandidate.priority > currentBest.priority;
	}
	if (nextCandidate.nextAttemptAt !== currentBest.nextAttemptAt) {
		return nextCandidate.nextAttemptAt < currentBest.nextAttemptAt;
	}
	return (nextCandidate.lastRequestedAt ?? 0) > (currentBest.lastRequestedAt ?? 0);
}

async function getAniListBudgetRow(ctx: MutationCtx): Promise<AnimeApiBudgetRow | null> {
	const rows = await ctx.db
		.query('animeApiBudget')
		.withIndex('by_provider', (q) => q.eq('provider', ANILIST_PROVIDER))
		.collect();
	const [budgetRow, ...duplicates] = rows;
	for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
	return (budgetRow as AnimeApiBudgetRow | undefined) ?? null;
}

async function tryAcquireAnimeLeaseHandler(
	ctx: MutationCtx,
	args: {
		leaseKey: string;
		leaseKind: 'title_sync' | 'seed_sweep';
		jobType?: 'season' | 'timeline';
		tmdbType?: 'movie' | 'tv';
		tmdbId?: number;
		seedTable?: 'tvShows' | 'movies';
		now: number;
		ttlMs: number;
		owner: string;
	}
) {
	const existing = await ctx.db
		.query('animeSyncLeases')
		.withIndex('by_leaseKey', (q) => q.eq('leaseKey', args.leaseKey))
		.collect();
	const [activeLease, ...duplicates] = existing;
	for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
	const leaseExpiresAt = args.now + args.ttlMs;

	if (!activeLease) {
		const leaseId = await ctx.db.insert('animeSyncLeases', {
			leaseKey: args.leaseKey,
			leaseKind: args.leaseKind,
			jobType: args.jobType,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			seedTable: args.seedTable,
			owner: args.owner,
			leasedAt: args.now,
			leaseExpiresAt
		});
		return { acquired: true, leaseId, leaseExpiresAt };
	}

	if (activeLease.owner === args.owner || activeLease.leaseExpiresAt <= args.now) {
		await ctx.db.patch(activeLease._id, {
			leaseKey: args.leaseKey,
			leaseKind: args.leaseKind,
			jobType: args.jobType,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			seedTable: args.seedTable,
			owner: args.owner,
			leasedAt: args.now,
			leaseExpiresAt
		});
		return { acquired: true, leaseId: activeLease._id, leaseExpiresAt };
	}

	return { acquired: false, leaseId: null, leaseExpiresAt: activeLease.leaseExpiresAt };
}

async function releaseAnimeLeaseHandler(
	ctx: MutationCtx,
	args: { leaseId: Id<'animeSyncLeases'>; owner: string }
) {
	const lease = await ctx.db.get(args.leaseId);
	if (!lease || lease.owner !== args.owner) return;
	await ctx.db.delete(args.leaseId);
}

async function upsertAnimeSyncQueueRequestHandler(
	ctx: MutationCtx,
	args: {
		jobType: 'season' | 'timeline';
		tmdbType: 'movie' | 'tv';
		tmdbId: number;
		priority: number;
		now: number;
		force?: boolean;
	}
) {
	const syncKey = animeSyncQueueKey(args.jobType, args.tmdbType, args.tmdbId);
	const rows = await ctx.db
		.query('animeSyncQueue')
		.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
		.collect();
	const [existing, ...dups] = rows;
	for (const dup of dups) await ctx.db.delete(dup._id);
	const force = args.force === true;

	if (!existing) {
		const id = await ctx.db.insert('animeSyncQueue', {
			syncKey,
			jobType: args.jobType,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			state: 'queued',
			priority: args.priority,
			requestedAt: args.now,
			lastRequestedAt: args.now,
			nextAttemptAt: args.now,
			attemptCount: 0,
			estimatedAniListCost: animeSyncJobDefaultCost(args.jobType)
		});
		return { queued: true, inserted: true, rowId: id };
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
	if (!needsPatch) return { queued: nextState === 'queued', inserted: false, rowId: existing._id };
	await ctx.db.patch(existing._id, {
		priority: nextPriority,
		lastRequestedAt: args.now,
		nextAttemptAt,
		state: nextState,
		lastError: nextLastError
	});
	return { queued: nextState === 'queued', inserted: false, rowId: existing._id };
}

async function enqueueStaleAnimeSyncQueueJobsHandler(
	ctx: MutationCtx,
	args: { now: number; jobType?: 'season' | 'timeline'; limit?: number; priority?: number }
) {
	const now = args.now;
	const limit = Math.max(1, Math.min(args.limit ?? 25, 200));
	const rows = await ctx.db
		.query('animeSyncQueue')
		.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', now))
		.order('asc')
		.collect();
	let enqueued = 0;
	for (const row of rows) {
		if (enqueued >= limit) break;
		if (args.jobType && row.jobType !== args.jobType) continue;
		if (row.state === 'running' || row.state === 'queued' || row.state === 'retry') continue;
		await ctx.db.patch(row._id, {
			state: 'queued',
			nextAttemptAt: now,
			priority: Math.max(row.priority, args.priority ?? animeSyncQueueDefaultPriority(row.jobType)),
			lastRequestedAt: now
		});
		enqueued += 1;
	}
	return { enqueued };
}

async function claimNextAnimeSyncQueueJobHandler(
	ctx: MutationCtx,
	args: { now: number; jobType?: 'season' | 'timeline' }
) {
	let picked: AnimeSyncQueueRow | null = null;
	for (const state of CLAIMABLE_QUEUE_STATES) {
		const rows = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_state_nextAttemptAt', (q) =>
				q.eq('state', state).lte('nextAttemptAt', args.now)
			)
			.order('asc')
			.collect();
		for (const row of rows) {
			if (args.jobType && row.jobType !== args.jobType) continue;
			const candidate = row as AnimeSyncQueueRow;
			if (isBetterQueueCandidate(candidate, picked)) picked = candidate;
		}
	}
	if (!picked) return null;
	const pickedId = picked._id;
	const rowsForSyncKey = await ctx.db
		.query('animeSyncQueue')
		.withIndex('by_syncKey', (q) => q.eq('syncKey', picked.syncKey))
		.collect();
	const activeRunning = rowsForSyncKey.find(
		(row) => row.state === 'running' && row._id !== pickedId
	);
	if (activeRunning) {
		for (const row of rowsForSyncKey) {
			if (row._id === activeRunning._id) continue;
			await ctx.db.delete(row._id);
		}
		return null;
	}
	for (const row of rowsForSyncKey) {
		if (row._id === picked._id) continue;
		await ctx.db.delete(row._id);
	}
	const freshPicked = await ctx.db.get(picked._id);
	if (!freshPicked) return null;
	if (freshPicked.state === 'running') return null;
	if (
		(freshPicked.state !== 'queued' && freshPicked.state !== 'retry') ||
		(freshPicked.nextAttemptAt ?? 0) > args.now
	) {
		return null;
	}
	await ctx.db.patch(freshPicked._id, {
		state: 'running',
		lastStartedAt: args.now,
		attemptCount: (freshPicked.attemptCount ?? 0) + 1,
		lastError: undefined
	});
	return await ctx.db.get(freshPicked._id);
}

async function finishAnimeSyncQueueJobHandler(
	ctx: MutationCtx,
	args: {
		rowId: Id<'animeSyncQueue'>;
		now: number;
		outcome: 'success' | 'retry' | 'error';
		nextAttemptAt?: number;
		nextRefreshAt?: number;
		lastError?: string;
		lastResultStatus?: string;
		animeEligibilityCheck?:
			| 'agree'
			| 'auto_disagree'
			| 'manual_override_disagree'
			| 'db_missing_used_heuristic';
		estimatedAniListCost?: number;
	}
) {
	const row = await ctx.db.get(args.rowId);
	if (!row) return null;
	const state: Doc<'animeSyncQueue'>['state'] =
		args.outcome === 'success' ? 'idle' : args.outcome === 'retry' ? 'retry' : 'error';
	await ctx.db.patch(args.rowId, {
		state,
		lastFinishedAt: args.now,
		lastSuccessAt: args.outcome === 'success' ? args.now : row.lastSuccessAt,
		nextAttemptAt: args.nextAttemptAt ?? row.nextAttemptAt,
		nextRefreshAt: args.nextRefreshAt ?? row.nextRefreshAt,
		lastError: args.lastError,
		lastResultStatus: args.lastResultStatus ?? row.lastResultStatus,
		animeEligibilityCheck: args.animeEligibilityCheck ?? row.animeEligibilityCheck,
		estimatedAniListCost: args.estimatedAniListCost ?? row.estimatedAniListCost
	});
	return await ctx.db.get(args.rowId);
}

async function pruneAnimeSyncQueueHandler(ctx: MutationCtx, args: { now: number; limit?: number }) {
	const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
	const cutoff = args.now - ANIME_SYNC_QUEUE_PRUNE_AGE_MS;
	let deleted = 0;
	for (const state of PRUNABLE_QUEUE_STATES) {
		if (deleted >= limit) break;
		const rows = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_state_nextAttemptAt', (q) => q.eq('state', state).lte('nextAttemptAt', cutoff))
			.order('asc')
			.collect();
		for (const row of rows) {
			if (deleted >= limit) break;
			if ((row.lastRequestedAt ?? 0) > cutoff) continue;
			const status = row.lastResultStatus ?? '';
			const isSkippedNonAnime =
				status === 'skipped_not_anime_db' ||
				status === 'skipped_non_anime' ||
				status === 'skipped_missing_media_db';
			const isStaleError = row.state === 'error' || row.state === 'retry';
			if (!isSkippedNonAnime && !isStaleError) continue;
			await ctx.db.delete(row._id);
			deleted += 1;
		}
	}
	return { deleted };
}

async function reserveAniListBudgetHandler(ctx: MutationCtx, args: { now: number; cost: number }) {
	const now = args.now;
	const requestedCost = Math.max(1, Math.ceil(args.cost));
	let budgetRow = await getAniListBudgetRow(ctx);
	const budgetWindow = computeAniListBudgetWindow(now, budgetRow);
	if (!budgetRow) {
		const rowId = await ctx.db.insert('animeApiBudget', {
			provider: ANILIST_PROVIDER,
			tokens: budgetWindow.refilledTokens,
			capacity: budgetWindow.effectiveCapacity,
			baseCapacity: budgetWindow.baseCapacity,
			refillPerMinute: budgetWindow.baseRefill,
			lastRefillAt: now,
			throttleFactor: budgetWindow.throttleFactor,
			consecutive429s: 0,
			updatedAt: now
		});
		budgetRow = await ctx.db.get(rowId);
		if (!budgetRow) return { reserved: false, nextAllowedAt: now + 60_000, availableTokens: 0 };
	}
	if ((budgetRow.cooldownUntil ?? 0) > now) {
		await ctx.db.patch(budgetRow._id, {
			tokens: budgetWindow.refilledTokens,
			capacity: budgetWindow.effectiveCapacity,
			lastRefillAt: now,
			updatedAt: now
		});
		return {
			reserved: false,
			nextAllowedAt: budgetRow.cooldownUntil ?? now + 60_000,
			availableTokens: budgetWindow.refilledTokens
		};
	}
	if (budgetWindow.refilledTokens < requestedCost) {
		const deficit = requestedCost - budgetWindow.refilledTokens;
		const waitMs = Math.ceil((deficit / budgetWindow.effectiveRefill) * 60_000);
		await ctx.db.patch(budgetRow._id, {
			tokens: budgetWindow.refilledTokens,
			capacity: budgetWindow.effectiveCapacity,
			lastRefillAt: now,
			updatedAt: now
		});
		return {
			reserved: false,
			nextAllowedAt: now + Math.max(1_000, waitMs),
			availableTokens: budgetWindow.refilledTokens
		};
	}
	const remaining = budgetWindow.refilledTokens - requestedCost;
	await ctx.db.patch(budgetRow._id, {
		tokens: remaining,
		capacity: budgetWindow.effectiveCapacity,
		lastRefillAt: now,
		updatedAt: now
	});
	return { reserved: true, nextAllowedAt: now, availableTokens: remaining };
}

async function recordAniListBudgetOutcomeHandler(
	ctx: MutationCtx,
	args: { now: number; outcome: 'success' | 'rate_limited' | 'failure' }
) {
	const now = args.now;
	const budgetRow = await getAniListBudgetRow(ctx);
	if (!budgetRow) return null;
	const currentFactor = clampAniListThrottleFactor(budgetRow.throttleFactor ?? 1);
	const current429s = budgetRow.consecutive429s ?? 0;
	if (args.outcome === 'success') {
		const next429s = Math.max(0, current429s - 1);
		const nextFactor = clampAniListThrottleFactor(currentFactor + 0.03);
		await ctx.db.patch(budgetRow._id, {
			throttleFactor: nextFactor,
			consecutive429s: next429s,
			cooldownUntil: (budgetRow.cooldownUntil ?? 0) > now ? budgetRow.cooldownUntil : undefined,
			updatedAt: now
		});
		return { throttleFactor: nextFactor, consecutive429s: next429s };
	}
	if (args.outcome === 'rate_limited') {
		const next429s = current429s + 1;
		const nextFactor = clampAniListThrottleFactor(currentFactor * 0.65);
		const cooldownMs = Math.min(10 * 60_000, 60_000 * Math.max(1, next429s));
		await ctx.db.patch(budgetRow._id, {
			throttleFactor: nextFactor,
			consecutive429s: next429s,
			last429At: now,
			cooldownUntil: now + cooldownMs,
			updatedAt: now
		});
		return {
			throttleFactor: nextFactor,
			consecutive429s: next429s,
			cooldownUntil: now + cooldownMs
		};
	}
	await ctx.db.patch(budgetRow._id, { updatedAt: now });
	return { throttleFactor: currentFactor, consecutive429s: current429s };
}

async function recordAniListBudgetHeadersHandler(
	ctx: MutationCtx,
	args: {
		now: number;
		limit?: number;
		remaining?: number;
		resetAtMs?: number;
		retryAfterMs?: number;
	}
) {
	const now = args.now;
	const budgetRow = await getAniListBudgetRow(ctx);
	if (!budgetRow) return null;
	const currentFactor = clampAniListThrottleFactor(budgetRow.throttleFactor ?? 1);
	const currentBaseCapacity = Math.max(
		1,
		Math.floor(budgetRow.baseCapacity ?? ANILIST_BASE_BUDGET_PER_MIN)
	);
	const currentBaseRefill = Math.max(
		1,
		Math.floor(budgetRow.refillPerMinute ?? ANILIST_BASE_BUDGET_PER_MIN)
	);
	const headerLimit =
		typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
			? Math.max(1, Math.floor(args.limit))
			: null;
	const nextBaseCapacity = headerLimit ?? currentBaseCapacity;
	const nextBaseRefill = headerLimit ?? currentBaseRefill;
	const budgetWindow = computeAniListBudgetWindow(now, budgetRow, {
		baseCapacity: nextBaseCapacity,
		baseRefill: nextBaseRefill,
		throttleFactor: currentFactor
	});
	const headerRemaining =
		typeof args.remaining === 'number' && Number.isFinite(args.remaining) && args.remaining >= 0
			? Math.max(0, Math.floor(args.remaining))
			: null;
	const nextTokens =
		headerRemaining == null
			? budgetWindow.refilledTokens
			: Math.min(
					budgetWindow.refilledTokens,
					Math.min(budgetWindow.effectiveCapacity, headerRemaining)
				);
	const headerRetryAfterMs =
		typeof args.retryAfterMs === 'number' &&
		Number.isFinite(args.retryAfterMs) &&
		args.retryAfterMs > 0
			? Math.max(1000, Math.floor(args.retryAfterMs))
			: null;
	const headerResetAtMs =
		typeof args.resetAtMs === 'number' && Number.isFinite(args.resetAtMs) && args.resetAtMs > now
			? Math.floor(args.resetAtMs)
			: null;
	let nextCooldownUntil = budgetRow.cooldownUntil;
	if (headerRetryAfterMs != null)
		nextCooldownUntil = Math.max(nextCooldownUntil ?? 0, now + headerRetryAfterMs);
	if (
		headerResetAtMs != null &&
		(headerRemaining == null || headerRemaining <= 1 || headerRetryAfterMs != null)
	) {
		nextCooldownUntil = Math.max(nextCooldownUntil ?? 0, headerResetAtMs);
	}
	await ctx.db.patch(budgetRow._id, {
		baseCapacity: nextBaseCapacity,
		refillPerMinute: nextBaseRefill,
		capacity: budgetWindow.effectiveCapacity,
		tokens: nextTokens,
		lastRefillAt: now,
		cooldownUntil: nextCooldownUntil,
		updatedAt: now
	});
	return {
		baseCapacity: nextBaseCapacity,
		refillPerMinute: nextBaseRefill,
		capacity: budgetWindow.effectiveCapacity,
		tokens: nextTokens,
		cooldownUntil: nextCooldownUntil ?? null
	};
}

async function refundAniListBudgetReservationHandler(
	ctx: MutationCtx,
	args: { now: number; refundAmount: number }
) {
	const now = args.now;
	const refundAmount = Math.max(0, Math.floor(args.refundAmount));
	if (refundAmount <= 0) return { refunded: 0, tokens: null as number | null };
	const budgetRow = await getAniListBudgetRow(ctx);
	if (!budgetRow) return { refunded: 0, tokens: null as number | null };
	const budgetWindow = computeAniListBudgetWindow(now, budgetRow);
	const nextTokens = Math.min(
		budgetWindow.effectiveCapacity,
		budgetWindow.refilledTokens + refundAmount
	);
	const refunded = Math.max(0, Math.floor(nextTokens - budgetWindow.refilledTokens));
	if (refunded <= 0) {
		await ctx.db.patch(budgetRow._id, {
			tokens: budgetWindow.refilledTokens,
			capacity: budgetWindow.effectiveCapacity,
			lastRefillAt: now,
			updatedAt: now
		});
		return { refunded: 0, tokens: budgetWindow.refilledTokens };
	}
	await ctx.db.patch(budgetRow._id, {
		tokens: nextTokens,
		capacity: budgetWindow.effectiveCapacity,
		lastRefillAt: now,
		updatedAt: now
	});
	return { refunded, tokens: nextTokens };
}

export const tryAcquireAnimeLease = internalMutation({
	args: {
		leaseKey: v.string(),
		leaseKind: v.union(v.literal('title_sync'), v.literal('seed_sweep')),
		jobType: v.optional(animeSyncJobTypeValidator),
		tmdbType: v.optional(tmdbTypeValidator),
		tmdbId: v.optional(v.number()),
		seedTable: v.optional(animeSeedTableValidator),
		now: v.number(),
		ttlMs: v.number(),
		owner: v.string()
	},
	handler: tryAcquireAnimeLeaseHandler
});

export const releaseAnimeLease = internalMutation({
	args: {
		leaseId: v.id('animeSyncLeases'),
		owner: v.string()
	},
	handler: releaseAnimeLeaseHandler
});

export const upsertAnimeSyncQueueRequest = internalMutation({
	args: {
		jobType: animeSyncJobTypeValidator,
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		priority: v.number(),
		now: v.number(),
		force: v.optional(v.boolean())
	},
	handler: upsertAnimeSyncQueueRequestHandler
});

export const enqueueStaleAnimeSyncQueueJobs = internalMutation({
	args: {
		now: v.number(),
		jobType: v.optional(animeSyncJobTypeValidator),
		limit: v.optional(v.number()),
		priority: v.optional(v.number())
	},
	handler: enqueueStaleAnimeSyncQueueJobsHandler
});

export const claimNextAnimeSyncQueueJob = internalMutation({
	args: {
		now: v.number(),
		jobType: v.optional(animeSyncJobTypeValidator)
	},
	handler: claimNextAnimeSyncQueueJobHandler
});

export const finishAnimeSyncQueueJob = internalMutation({
	args: {
		rowId: v.id('animeSyncQueue'),
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('retry'), v.literal('error')),
		nextAttemptAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string()),
		animeEligibilityCheck: v.optional(
			v.union(
				v.literal('agree'),
				v.literal('auto_disagree'),
				v.literal('manual_override_disagree'),
				v.literal('db_missing_used_heuristic')
			)
		),
		estimatedAniListCost: v.optional(v.number())
	},
	handler: finishAnimeSyncQueueJobHandler
});

export const reserveAniListBudget = internalMutation({
	args: {
		now: v.number(),
		cost: v.number()
	},
	handler: reserveAniListBudgetHandler
});

export const recordAniListBudgetOutcome = internalMutation({
	args: {
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('rate_limited'), v.literal('failure'))
	},
	handler: recordAniListBudgetOutcomeHandler
});

export const recordAniListBudgetHeaders = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number()),
		remaining: v.optional(v.number()),
		resetAtMs: v.optional(v.number()),
		retryAfterMs: v.optional(v.number())
	},
	handler: recordAniListBudgetHeadersHandler
});

export const refundAniListBudgetReservation = internalMutation({
	args: {
		now: v.number(),
		refundAmount: v.number()
	},
	handler: refundAniListBudgetReservationHandler
});

export const pruneAnimeSyncQueue = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: pruneAnimeSyncQueueHandler
});

export const getAnimeQueueSeedCandidatesPage = internalQuery({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.max(25, Math.min(args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE, 500));
		const cursor = args.cursor ?? null;
		if (args.table === 'tvShows') {
			const page = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId')
				.order('asc')
				.paginate({ numItems: limit, cursor });
			const candidates = (
				await Promise.all(
					page.page.map(async (row): Promise<AnimeQueueSeedCandidate | null> => {
						if (typeof row.tmdbId !== 'number') return null;
						const finalRow = await getFinalTV(ctx, row);
						if (finalRow.isAnime !== true) return null;
						return { tmdbType: 'tv' as const, tmdbId: row.tmdbId as number };
					})
				)
			).filter((candidate): candidate is AnimeQueueSeedCandidate => candidate !== null);
			return {
				table: args.table,
				scanned: page.page.length,
				candidates,
				done: page.isDone,
				nextCursor: page.isDone ? null : page.continueCursor
			};
		}

		const page = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId')
			.order('asc')
			.paginate({ numItems: limit, cursor });
		const candidates = (
			await Promise.all(
				page.page.map(async (row): Promise<AnimeQueueSeedCandidate | null> => {
					if (typeof row.tmdbId !== 'number') return null;
					const finalRow = await getFinalMovie(ctx, row);
					if (finalRow.isAnime !== true) return null;
					return { tmdbType: 'movie' as const, tmdbId: row.tmdbId as number };
				})
			)
		).filter((candidate): candidate is AnimeQueueSeedCandidate => candidate !== null);
		return {
			table: args.table,
			scanned: page.page.length,
			candidates,
			done: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor
		};
	}
});

export const getAnimeSeasonEnqueueStatusByTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const eligibility = (await (async () => {
			if (args.tmdbType === 'tv') {
				const base = await ctx.db
					.query('tvShows')
					.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
					.unique();
				const row = base ? await getFinalTV(ctx, base) : null;
				return {
					found: row !== null,
					isAnime: row?.isAnime ?? null
				};
			}
			const base = await ctx.db
				.query('movies')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique();
			const row = base ? await getFinalMovie(ctx, base) : null;
			return {
				found: row !== null,
				isAnime: row?.isAnime ?? null
			};
		})()) as { found: boolean; isAnime: boolean | null };

		if (eligibility.isAnime !== true) {
			return {
				found: eligibility.found,
				isAnime: eligibility.isAnime,
				shouldEnqueue: false,
				reason: eligibility.found ? ('not_anime' as const) : ('missing_media_row' as const)
			};
		}

		const syncKey = animeSyncQueueKey('season', args.tmdbType, args.tmdbId);
		const queueRow = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
			.unique();

		if (!queueRow) {
			return {
				found: true,
				isAnime: true as const,
				shouldEnqueue: true,
				reason: 'missing_queue_row' as const
			};
		}

		const isDue = (queueRow.nextRefreshAt ?? 0) <= args.now || queueRow.lastSuccessAt == null;
		const isRecoverableState =
			queueRow.state === 'error' || queueRow.state === 'retry' || queueRow.state === 'idle';
		const shouldEnqueue =
			queueRow.state === 'queued' || queueRow.state === 'running'
				? false
				: isDue || isRecoverableState;

		return {
			found: true,
			isAnime: true as const,
			shouldEnqueue,
			reason: shouldEnqueue
				? ('queue_missing_or_stale' as const)
				: ('queue_fresh_or_active' as const),
			queueState: queueRow.state,
			nextRefreshAt: queueRow.nextRefreshAt ?? null,
			lastSuccessAt: queueRow.lastSuccessAt ?? null
		};
	}
});

export const getTVEpisodeRefreshSignalsByTMDBIds = internalQuery({
	args: {
		tmdbIds: v.array(v.number())
	},
	handler: async (ctx, args) => {
		const uniqueIds = Array.from(new Set(args.tmdbIds));
		const rows: TVEpisodeRefreshSignals[] = [];
		for (const tmdbId of uniqueIds) {
			const base = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
				.unique();
			const row = base ? await getFinalTV(ctx, base) : null;
			if (!row) continue;
			rows.push({
				tmdbId,
				status: row.status ?? null,
				lastAirDate: row.lastAirDate ?? null,
				lastEpisodeToAir: row.lastEpisodeToAir ?? null,
				nextEpisodeToAir: row.nextEpisodeToAir ?? null
			});
		}
		return rows;
	}
});

export const getXrefByTMDB = internalQuery({
	args: { tmdbType: tmdbTypeValidator, tmdbId: v.number() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeXref')
			.withIndex('by_tmdbType_tmdbId', (q) =>
				q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
			)
			.collect();
		return rows[0] ?? null;
	}
});

export const getStoredAnimeEligibilityByTMDB = internalQuery({
	args: { tmdbType: tmdbTypeValidator, tmdbId: v.number() },
	handler: async (ctx, args) => {
		if (args.tmdbType === 'tv') {
			const base = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique();
			const row = base ? await getFinalTV(ctx, base) : null;
			return {
				found: row !== null,
				isAnime: row?.isAnime ?? null,
				isAnimeSource: row?.isAnimeSource ?? null,
				status: row?.status ?? null,
				lastAirDate: row?.lastAirDate ?? null,
				lastEpisodeToAir: row?.lastEpisodeToAir ?? null,
				nextEpisodeToAir: row?.nextEpisodeToAir ?? null,
				releaseDate: row?.releaseDate ?? null
			};
		}
		const base = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
			.unique();
		const row = base ? await getFinalMovie(ctx, base) : null;
		return {
			found: row !== null,
			isAnime: row?.isAnime ?? null,
			isAnimeSource: row?.isAnimeSource ?? null,
			status: row?.status ?? null,
			lastAirDate: null,
			lastEpisodeToAir: null,
			nextEpisodeToAir: null,
			releaseDate: row?.releaseDate ?? null
		};
	}
});

export const upsertAnimeXrefAuto = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		title: v.object({
			tmdb: v.string(),
			anilistEnglish: v.union(v.string(), v.null()),
			anilistRomaji: v.union(v.string(), v.null())
		}),
		anilistId: v.number(),
		confidence: v.number(),
		method: v.union(v.literal('tmdb_external_ids'), v.literal('title_year_episodes')),
		candidates: v.optional(v.array(animeXrefCandidateValidator))
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeXref')
			.withIndex('by_tmdbType_tmdbId', (q) =>
				q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
			)
			.collect();
		const [existing, ...duplicates] = rows;
		for (const dup of duplicates) {
			await ctx.db.delete(dup._id);
		}

		if (existing?.locked === true) {
			return { row: existing, skippedLocked: true };
		}

		const patch = {
			title: args.title,
			anilistId: args.anilistId,
			confidence: args.confidence,
			method: args.method,
			candidates: args.candidates,
			updatedAt: Date.now()
		} as const;

		if (existing) {
			await ctx.db.patch(existing._id, patch);
			const next = await ctx.db.get(existing._id);
			return { row: next, skippedLocked: false };
		}

		const id = await ctx.db.insert('animeXref', {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			...patch
		});
		const row = await ctx.db.get(id);
		return { row, skippedLocked: false };
	}
});

export const upsertAniListMediaBatch = internalMutation({
	args: {
		items: v.array(
			v.object({
				anilistId: v.number(),
				title: anilistTitleValidator,
				format: v.optional(v.string()),
				startDate: v.optional(anilistDateValidator),
				seasonYear: v.optional(v.number()),
				episodes: v.optional(v.number()),
				description: v.optional(v.string()),
				studios: v.optional(v.array(anilistStudioValidator))
			})
		),
		schemaVersion: v.number()
	},
	handler: async (ctx, args) => {
		let inserted = 0;
		let updated = 0;
		for (const item of args.items) {
			const rows = await ctx.db
				.query('anilistMedia')
				.withIndex('by_anilistId', (q) => q.eq('anilistId', item.anilistId))
				.collect();
			const [existing, ...duplicates] = rows;
			for (const dup of duplicates) {
				await ctx.db.delete(dup._id);
			}
			const payload = {
				...item,
				fetchedAt: Date.now(),
				schemaVersion: args.schemaVersion
			};
			if (existing) {
				await ctx.db.patch(existing._id, payload);
				updated += 1;
			} else {
				await ctx.db.insert('anilistMedia', payload);
				inserted += 1;
			}
		}
		return { inserted, updated };
	}
});

export const replaceAnimeDisplaySeasonsAuto = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		rows: v.array(
			v.object({
				rowKey: v.string(),
				label: v.string(),
				sortOrder: v.number(),
				rowType: v.union(v.literal('main'), v.literal('specials')),
				seasonOrdinal: v.optional(v.union(v.number(), v.null())),
				episodeNumberingMode: v.optional(
					v.union(v.literal('restarting'), v.literal('continuous'), v.null())
				),
				status: v.optional(
					v.union(
						v.literal('open'),
						v.literal('soft_closed'),
						v.literal('auto_soft_closed'),
						v.literal('closed'),
						v.null()
					)
				),
				hidden: v.optional(v.boolean()),
				sources: v.array(
					v.object({
						// Stable source-block identifier inside a row.
						sourceKey: v.string(),
						// Explicit in-row source ordering (lower renders first).
						sequence: v.number(),
						tmdbSeasonNumber: v.number(),
						tmdbEpisodeStart: v.union(v.number(), v.null()),
						tmdbEpisodeEnd: v.union(v.number(), v.null()),
						displayAsRegularEpisode: v.optional(v.boolean())
					})
				)
			})
		)
	},
	handler: async (ctx, args) => {
		const titleOverrideRows = await ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const titleOverride = titleOverrideRows[0] ?? null;
		const existingRows = await ctx.db
			.query('animeDisplaySeasons')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const hasExistingRows = existingRows.length > 0;
		const hasManualRows = existingRows.some((row) => row.sourceMode === 'manual');
		if (hasManualRows) {
			if (!titleOverride) {
				await ctx.db.insert('animeTitleOverrides', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					displayPlanMode: 'custom',
					updatedAt: Date.now()
				});
			} else if (resolveDisplayPlanMode(titleOverride) !== 'custom') {
				await ctx.db.patch(titleOverride._id, {
					displayPlanMode: 'custom',
					updatedAt: Date.now()
				});
			}
			return { skippedCustom: true, inserted: 0, deleted: 0 };
		}
		if (resolveDisplayPlanMode(titleOverride) === 'custom' && hasExistingRows) {
			return { skippedCustom: true, inserted: 0, deleted: 0 };
		}
		if (resolveDisplayPlanMode(titleOverride) === 'custom' && !hasExistingRows && titleOverride) {
			await ctx.db.patch(titleOverride._id, {
				displayPlanMode: 'auto',
				updatedAt: Date.now()
			});
		}
		let deleted = 0;
		for (const row of existingRows) {
			await ctx.db.delete(row._id);
			deleted += 1;
		}

		const now = Date.now();
		let inserted = 0;
		for (const row of args.rows) {
			await ctx.db.insert('animeDisplaySeasons', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				rowKey: row.rowKey,
				label: row.label,
				sortOrder: row.sortOrder,
				rowType: row.rowType,
				seasonOrdinal: row.seasonOrdinal ?? null,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				status: row.status ?? null,
				hidden: row.hidden ?? false,
				sourceMode: 'auto',
				locked: false,
				sources: row.sources.map((source) => ({
					sourceKey: source.sourceKey,
					sequence: source.sequence,
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
					displayAsRegularEpisode: source.displayAsRegularEpisode === true
				})),
				updatedAt: now
			});
			inserted += 1;
		}
		return { skippedCustom: false, inserted, deleted };
	}
});

export const seedAnimeSyncQueueFromStoredMedia = internalAction({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
		leaseOwner: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const leaseOwner = args.leaseOwner ?? createAnimeSyncLeaseOwner(now);
		const lease = (await ctx.runMutation(internal.animeSync.tryAcquireAnimeLease, {
			leaseKey: animeSeedSweepLeaseKey(args.table),
			leaseKind: 'seed_sweep',
			seedTable: args.table,
			now,
			ttlMs: ANIME_QUEUE_SEED_SWEEP_LEASE_TTL_MS,
			owner: leaseOwner
		})) as { acquired: boolean; leaseId: Id<'animeSyncLeases'> | null; leaseExpiresAt: number };
		if (!lease.acquired || lease.leaseId === null) {
			return {
				table: args.table,
				scanned: 0,
				animeCandidates: 0,
				inserted: 0,
				queued: 0,
				done: false,
				nextCursor: args.cursor ?? null,
				status: 'skipped_busy' as const,
				leaseExpiresAt: lease.leaseExpiresAt
			};
		}

		let continuationScheduled = false;
		let pageDone = false;

		try {
			const page = (await ctx.runQuery(internal.animeSync.getAnimeQueueSeedCandidatesPage, {
				table: args.table,
				cursor: args.cursor ?? null,
				limit: args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE
			})) as {
				table: 'tvShows' | 'movies';
				scanned: number;
				candidates: AnimeQueueSeedCandidate[];
				done: boolean;
				nextCursor: string | null;
			};

			let inserted = 0;
			let queued = 0;
			const seenKeys = new Set<string>();
			for (const candidate of page.candidates) {
				const key = animeSyncQueueKey('season', candidate.tmdbType, candidate.tmdbId);
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);
				const result = (await ctx.runMutation(internal.animeSync.upsertAnimeSyncQueueRequest, {
					jobType: 'season',
					tmdbType: candidate.tmdbType,
					tmdbId: candidate.tmdbId,
					priority: animeSyncQueueDefaultPriority('season'),
					now
				})) as { queued: boolean; inserted: boolean };
				if (result.inserted) inserted += 1;
				if (result.queued) queued += 1;
			}

			if (queued > 0) {
				try {
					await ctx.scheduler.runAfter(0, internal.animeSync.processAnimeSyncQueue, {
						maxJobs: 1,
						jobType: 'season'
					});
				} catch (error) {
					console.warn(
						'[anime] failed to schedule queue processor after seeding anime sync queue',
						{
							table: args.table,
							error
						}
					);
				}
			}

			if (!page.done && page.nextCursor) {
				try {
					await ctx.scheduler.runAfter(0, internal.animeSync.seedAnimeSyncQueueFromStoredMedia, {
						table: args.table,
						cursor: page.nextCursor,
						limit: args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE,
						leaseOwner
					});
					continuationScheduled = true;
				} catch (error) {
					console.warn('[anime] failed to schedule continuation for anime queue seed sweep', {
						table: args.table,
						error
					});
				}
			}

			pageDone = page.done;

			return {
				table: page.table,
				scanned: page.scanned,
				animeCandidates: page.candidates.length,
				inserted,
				queued,
				done: page.done,
				nextCursor: page.nextCursor
			};
		} finally {
			if (pageDone || !continuationScheduled) {
				await ctx.runMutation(internal.animeSync.releaseAnimeLease, {
					leaseId: lease.leaseId,
					owner: leaseOwner
				});
			}
		}
	}
});

export const enqueueStaleAnimeSeasonRefreshes: ReturnType<typeof internalAction> = internalAction({
	args: {
		limit: v.optional(v.number())
	},
	handler: async (ctx, args): Promise<unknown> => {
		return await ctx.runMutation(internal.animeSync.enqueueStaleAnimeSyncQueueJobs, {
			now: Date.now(),
			jobType: 'season',
			limit: args.limit ?? 50,
			priority: animeSyncQueueDefaultPriority('season')
		});
	}
});

export const requestSeasonRefreshForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		const now = Date.now();
		const eligibility = (await ctx.runQuery(internal.animeSync.getStoredAnimeEligibilityByTMDB, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId
		})) as StoredAnimeRefreshSignals;
		if (eligibility.isAnime !== true && args.force !== true) {
			return {
				ok: true,
				queued: false,
				reason: eligibility.found ? 'not_anime' : 'missing_media_row'
			};
		}

		const queued = await ctx.runMutation(internal.animeSync.upsertAnimeSyncQueueRequest, {
			jobType: 'season',
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			priority: ANIME_SYNC_QUEUE_INTERACTIVE_SEASON_PRIORITY,
			now,
			force: args.force
		});

		if (queued.queued) {
			try {
				await ctx.scheduler.runAfter(0, internal.animeSync.processAnimeSyncQueue, {
					maxJobs: 1,
					jobType: 'season'
				});
			} catch (error) {
				console.warn('[animeSync] failed to schedule anime queue worker after enqueue', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}

		return {
			ok: true,
			queued
		};
	}
});

export const syncSeasonForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		forceNonAnime: v.optional(v.boolean()),
		forceRematch: v.optional(v.boolean()),
		scheduleTimeline: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		const result = await runAnimeSyncWithLease(
			ctx,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				forceNonAnime: args.forceNonAnime,
				forceRematch: args.forceRematch
			},
			{
				jobType: 'season',
				syncMode: 'season',
				leaseTtlMs: ANIME_SEASON_SYNC_LEASE_TTL_MS
			}
		);

		const shouldScheduleTimeline =
			args.scheduleTimeline === true && (result as { status?: string }).status === 'synced';
		if (shouldScheduleTimeline) {
			try {
				await ctx.scheduler.runAfter(0, api.animeSync.syncTimelineForTMDB, {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					forceNonAnime: args.forceNonAnime
				});
			} catch (error) {
				console.warn('[animeSync] failed to schedule timeline sync after season sync', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}

		try {
			await ctx.runAction(api.animeAlerts.refreshAnimeAlertsForTMDB, {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId
			});
		} catch (error) {
			console.warn('[animeSync] failed to refresh anime alerts after season sync', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				error
			});
		}

		return result;
	}
});

export const syncTimelineForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		forceNonAnime: v.optional(v.boolean()),
		forceRematch: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		return await runAnimeSyncWithLease(
			ctx,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				forceNonAnime: args.forceNonAnime,
				forceRematch: args.forceRematch
			},
			{
				jobType: 'timeline',
				syncMode: 'full',
				leaseTtlMs: ANIME_TIMELINE_SYNC_LEASE_TTL_MS
			}
		);
	}
});

export const processAnimeSyncQueue = internalAction({
	args: {
		maxJobs: v.optional(v.number()),
		jobType: v.optional(animeSyncJobTypeValidator)
	},
	handler: async (ctx, args) => {
		const maxJobs = Math.max(1, Math.min(args.maxJobs ?? 3, 10));
		const now = Date.now();
		await ctx.runMutation(internal.animeSync.pruneAnimeSyncQueue, {
			now,
			limit: 100
		});
		await ctx.runMutation(internal.animeSync.enqueueStaleAnimeSyncQueueJobs, {
			now,
			jobType: args.jobType,
			limit: 25,
			priority: args.jobType
				? animeSyncQueueDefaultPriority(args.jobType)
				: animeSyncQueueDefaultPriority('season')
		});

		let processed = 0;
		let rateLimited = false;
		for (let i = 0; i < maxJobs; i += 1) {
			const claimNow = Date.now();
			const claim = (await ctx.runMutation(internal.animeSync.claimNextAnimeSyncQueueJob, {
				now: claimNow,
				jobType: args.jobType
			})) as AnimeSyncQueueRow | null;
			if (!claim) break;

			const eligibility = (await ctx.runQuery(internal.animeSync.getStoredAnimeEligibilityByTMDB, {
				tmdbType: claim.tmdbType,
				tmdbId: claim.tmdbId
			})) as StoredAnimeRefreshSignals;
			if (eligibility.isAnime !== true) {
				const skippedAt = Date.now();
				await ctx.runMutation(internal.animeSync.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: skippedAt,
					outcome: 'success',
					nextRefreshAt: skippedAt + 30 * 24 * 60 * 60_000,
					lastError: undefined,
					lastResultStatus: eligibility.found ? 'skipped_not_anime_db' : 'skipped_missing_media_db',
					estimatedAniListCost: 1
				});
				continue;
			}

			const estimatedCost = normalizeAniListCost(claim.estimatedAniListCost, claim.jobType);
			const budgetReservedAt = Date.now();
			const budget = await ctx.runMutation(internal.animeSync.reserveAniListBudget, {
				now: budgetReservedAt,
				cost: estimatedCost
			});
			if (!(budget as { reserved?: boolean }).reserved) {
				const deferredAt = Date.now();
				await ctx.runMutation(internal.animeSync.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: deferredAt,
					outcome: 'retry',
					nextAttemptAt:
						(budget as { nextAllowedAt?: number }).nextAllowedAt ?? deferredAt + 60_000,
					lastError: 'Waiting for AniList quota budget',
					lastResultStatus: 'deferred_quota'
				});
				rateLimited = true;
				break;
			}

			try {
				let result: unknown;
				if (claim.jobType === 'season') {
					result = await ctx.runAction(api.animeSync.syncSeasonForTMDB, {
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						scheduleTimeline: false
					});
				} else {
					result = await ctx.runAction(api.animeSync.syncTimelineForTMDB, {
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId
					});
				}

				const rowResult = result as {
					status?: string;
					nodesFetched?: number;
					syncMode?: 'season' | 'full';
					aniListRequestAttempts?: number;
					aniListRateLimitedResponses?: number;
					aniListRateLimitHints?: {
						limit?: number;
						remaining?: number;
						resetAtMs?: number;
						retryAfterMs?: number;
					};
					animeEligibilityCheck?:
						| 'agree'
						| 'auto_disagree'
						| 'manual_override_disagree'
						| 'db_missing_used_heuristic';
				};
				const heuristicCost = Math.max(
					1,
					Math.min(90, (rowResult.nodesFetched ?? 0) + (claim.jobType === 'season' ? 2 : 4))
				);
				const learnedCost =
					typeof rowResult.aniListRequestAttempts === 'number' &&
					Number.isFinite(rowResult.aniListRequestAttempts) &&
					rowResult.aniListRequestAttempts > 0
						? Math.max(1, Math.min(90, Math.ceil(rowResult.aniListRequestAttempts)))
						: heuristicCost;
				const reservedCost = estimatedCost;
				const overReserved = Math.max(0, reservedCost - learnedCost);
				const refundCapByObserved = Math.floor(
					Math.max(0, learnedCost) * ANIME_BUDGET_REFUND_MAX_OBSERVED_COST_FACTOR
				);
				const refundAmount = Math.min(overReserved, refundCapByObserved);
				if (ANIME_COST_DEBUG_LOGS) {
					console.log('[anime-cost-debug] queue job result', {
						jobType: claim.jobType,
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						status: rowResult.status ?? 'unknown',
						syncMode: rowResult.syncMode ?? null,
						nodesFetched: rowResult.nodesFetched ?? null,
						aniListRequestAttempts: rowResult.aniListRequestAttempts ?? null,
						aniListRateLimitedResponses: rowResult.aniListRateLimitedResponses ?? null,
						aniListRateLimitHints: rowResult.aniListRateLimitHints ?? null,
						estimatedAniListCostPrev: claim.estimatedAniListCost ?? null,
						reservedCost,
						heuristicCost,
						learnedCost,
						overReserved,
						refundAmount
					});
				}
				if (rowResult.aniListRateLimitHints) {
					const budgetHeaderRecordedAt = Date.now();
					await ctx.runMutation(internal.animeSync.recordAniListBudgetHeaders, {
						now: budgetHeaderRecordedAt,
						limit: rowResult.aniListRateLimitHints.limit,
						remaining: rowResult.aniListRateLimitHints.remaining,
						resetAtMs: rowResult.aniListRateLimitHints.resetAtMs,
						retryAfterMs: rowResult.aniListRateLimitHints.retryAfterMs
					});
				}
				if (refundAmount > 0) {
					const refundResult = await ctx.runMutation(
						internal.animeSync.refundAniListBudgetReservation,
						{
							now: Date.now(),
							refundAmount
						}
					);
					if (ANIME_COST_DEBUG_LOGS) {
						console.log('[anime-cost-debug] queue job refund', {
							jobType: claim.jobType,
							tmdbType: claim.tmdbType,
							tmdbId: claim.tmdbId,
							refundAmountRequested: refundAmount,
							refundAmountApplied: refundResult?.refunded ?? null,
							tokensAfterRefund: refundResult?.tokens ?? null
						});
					}
				}
				const finishedAt = Date.now();
				const wasSkippedBusy = rowResult.status === 'skipped_busy';
				await ctx.runMutation(internal.animeSync.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: finishedAt,
					outcome: wasSkippedBusy ? 'retry' : 'success',
					nextAttemptAt: wasSkippedBusy ? finishedAt + 15_000 : undefined,
					nextRefreshAt: wasSkippedBusy
						? claim.nextRefreshAt
						: finishedAt + computeAnimeQueueRefreshTtlMs(finishedAt, claim.jobType, eligibility),
					lastError: wasSkippedBusy ? 'Sync busy, retrying' : undefined,
					lastResultStatus: rowResult.status ?? 'unknown',
					animeEligibilityCheck: rowResult.animeEligibilityCheck,
					estimatedAniListCost: learnedCost
				});
				if (ANIME_COST_DEBUG_LOGS) {
					console.log('[anime-cost-debug] queue job persisted', {
						jobType: claim.jobType,
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						estimatedAniListCostNext: learnedCost
					});
				}
				await ctx.runMutation(internal.animeSync.recordAniListBudgetOutcome, {
					now: Date.now(),
					outcome: 'success'
				});
				processed += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const isRateLimit = /\b429\b|rate limit|AniList API error 429/i.test(message);
				const failureAt = Date.now();
				if (isRateLimit) {
					await ctx.runMutation(internal.animeSync.recordAniListBudgetOutcome, {
						now: failureAt,
						outcome: 'rate_limited'
					});
				} else {
					await ctx.runMutation(internal.animeSync.recordAniListBudgetOutcome, {
						now: failureAt,
						outcome: 'failure'
					});
				}
				await ctx.runMutation(internal.animeSync.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: failureAt,
					outcome: 'retry',
					nextAttemptAt:
						failureAt +
						(isRateLimit
							? 2 * ANIME_SYNC_QUEUE_FAILURE_RETRY_MS
							: ANIME_SYNC_QUEUE_FAILURE_RETRY_MS),
					lastError: message.slice(0, 500),
					lastResultStatus: isRateLimit ? 'rate_limited' : 'failed'
				});
				if (isRateLimit) {
					rateLimited = true;
					break;
				}
			}
		}

		return { processed, rateLimited };
	}
});
