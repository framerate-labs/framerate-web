import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

import { internal } from '../../_generated/api';
import { computeRefreshErrorBackoffMs } from '../detailsRefreshService';
import {
	DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY,
	DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS
} from './constants';
import {
	ensureDetailRefreshQueueRow,
	isStaleRunningDetailQueueRow,
	requestDetailRefreshQueueRow
} from './queueState';

const DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS = 20 * 60_000;
const DETAIL_REFRESH_QUEUE_DUE_SCAN_LIMIT = 50;
const DETAIL_REFRESH_QUEUE_RECENT_PRIORITY_SCAN_LIMIT = 25;
const DETAIL_REFRESH_WORKER_RUNTIME_KEY = 'default';
const DETAIL_REFRESH_WORKER_SCHEDULE_DEBOUNCE_MS = 5_000;
const DETAIL_REFRESH_WORKER_ACTIVE_TTL_MS = 2 * 60_000;

type DetailRefreshQueueCandidate = Doc<'detailRefreshQueue'>;
type DetailRefreshRuntimeDoc = Doc<'detailRefreshRuntime'>;
type ClaimedDetailRefreshQueueRow = DetailRefreshQueueCandidate & {
	state: 'running';
	attemptCount: number;
};

type ScheduleWorkerArgs = {
	now: number;
	maxJobs: number;
	delayMs?: number;
	activeTtlMs?: number;
	preferredRowId?: DetailRefreshQueueCandidate['_id'];
};

async function ensureDetailRefreshRuntimeRow(ctx: MutationCtx): Promise<DetailRefreshRuntimeDoc> {
	const rows = await ctx.db
		.query('detailRefreshRuntime')
		.withIndex('by_runtimeKey', (q) => q.eq('runtimeKey', DETAIL_REFRESH_WORKER_RUNTIME_KEY))
		.take(8);
	if (rows.length > 0) {
		let canonical = rows[0] ?? null;
		for (const row of rows) {
			if (canonical == null || row._creationTime > canonical._creationTime) {
				canonical = row;
			}
		}
		if (!canonical) {
			throw new Error('Failed to resolve canonical detail refresh runtime row');
		}
		for (const row of rows) {
			if (row._id === canonical._id) continue;
			await ctx.db.delete(row._id);
		}
		return canonical;
	}
	const rowId = await ctx.db.insert('detailRefreshRuntime', {
		runtimeKey: DETAIL_REFRESH_WORKER_RUNTIME_KEY
	});
	const inserted = await ctx.db.get(rowId);
	if (!inserted) {
		throw new Error('Failed to create detail refresh runtime row');
	}
	return inserted;
}

function compareQueueCandidates(
	left: DetailRefreshQueueCandidate,
	right: DetailRefreshQueueCandidate
): number {
	const byPriority = right.priority - left.priority;
	if (byPriority !== 0) return byPriority;

	const leftAttemptAt = left.nextAttemptAt ?? 0;
	const rightAttemptAt = right.nextAttemptAt ?? 0;
	if (leftAttemptAt !== rightAttemptAt) {
		return leftAttemptAt - rightAttemptAt;
	}

	const leftRequestedAt = left.requestedAt ?? 0;
	const rightRequestedAt = right.requestedAt ?? 0;
	if (leftRequestedAt !== rightRequestedAt) {
		return leftRequestedAt - rightRequestedAt;
	}

	return left._creationTime - right._creationTime;
}

async function collectDueDetailRefreshQueueCandidates(
	ctx: MutationCtx,
	args: { now: number; mediaType?: 'movie' | 'tv' }
): Promise<DetailRefreshQueueCandidate[]> {
	const candidates = new Map<DetailRefreshQueueCandidate['_id'], DetailRefreshQueueCandidate>();
	const mediaType = args.mediaType ?? null;

	for (const state of ['queued', 'retry', 'idle'] as const) {
		const rows = mediaType
			? await ctx.db
					.query('detailRefreshQueue')
					.withIndex('by_state_mediaType_nextAttemptAt', (q) =>
						q.eq('state', state).eq('mediaType', mediaType).lte('nextAttemptAt', args.now)
					)
					.take(DETAIL_REFRESH_QUEUE_DUE_SCAN_LIMIT)
			: await ctx.db
					.query('detailRefreshQueue')
					.withIndex('by_state_nextAttemptAt', (q) =>
						q.eq('state', state).lte('nextAttemptAt', args.now)
					)
					.take(DETAIL_REFRESH_QUEUE_DUE_SCAN_LIMIT);
		for (const row of rows) {
			candidates.set(row._id, row);
		}

		if (mediaType == null && state !== 'idle') {
			const recentRows = await ctx.db
				.query('detailRefreshQueue')
				.withIndex('by_state_lastRequestedAt', (q) => q.eq('state', state))
				.order('desc')
				.take(DETAIL_REFRESH_QUEUE_RECENT_PRIORITY_SCAN_LIMIT);
			for (const row of recentRows) {
				if ((row.nextAttemptAt ?? 0) > args.now) continue;
				candidates.set(row._id, row);
			}
		}
	}

	return [...candidates.values()].sort(compareQueueCandidates);
}

async function hasDueDetailRefreshQueueCandidates(
	ctx: MutationCtx,
	args: { now: number; mediaType?: 'movie' | 'tv' }
): Promise<boolean> {
	const candidates = await collectDueDetailRefreshQueueCandidates(ctx, args);
	return candidates.length > 0;
}

async function tryClaimDetailRefreshQueueRow(
	ctx: MutationCtx,
	args: {
		rowId: DetailRefreshQueueCandidate['_id'];
		now: number;
	}
): Promise<(DetailRefreshQueueCandidate & { state: 'running'; attemptCount: number }) | null> {
	let row = await ctx.db.get(args.rowId);
	if (!row) return null;
	if (row.state === 'running') {
		if (!isStaleRunningDetailQueueRow(row, args.now, DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS)) {
			return null;
		}
		await ctx.db.patch(row._id, {
			state: 'queued',
			nextAttemptAt: Math.min(row.nextAttemptAt ?? args.now, args.now),
			lastRequestedAt: args.now
		});
		row = {
			...row,
			state: 'queued',
			nextAttemptAt: Math.min(row.nextAttemptAt ?? args.now, args.now),
			lastRequestedAt: args.now
		};
	}
	if (
		(row.state !== 'queued' && row.state !== 'retry' && row.state !== 'idle') ||
		(row.nextAttemptAt ?? 0) > args.now
	) {
		return null;
	}
	const nextAttemptCount = (row.attemptCount ?? 0) + 1;
	await ctx.db.patch(row._id, {
		state: 'running',
		lastStartedAt: args.now,
		attemptCount: nextAttemptCount,
		lastError: undefined
	});
	return {
		...row,
		state: 'running',
		attemptCount: nextAttemptCount
	};
}

async function scheduleDetailRefreshWorkerRun(
	ctx: MutationCtx,
	runtime: DetailRefreshRuntimeDoc,
	args: ScheduleWorkerArgs
) {
	const delayMs = Math.max(0, args.delayMs ?? 0);
	const activeTtlMs = Math.max(
		DETAIL_REFRESH_WORKER_SCHEDULE_DEBOUNCE_MS,
		args.activeTtlMs ?? DETAIL_REFRESH_WORKER_ACTIVE_TTL_MS
	);
	await ctx.db.patch(runtime._id, {
		workerActiveUntil: args.now + activeTtlMs,
		lastWorkerScheduledAt: args.now
	});
	await ctx.scheduler.runAfter(delayMs, internal.detailsRefresh.processDetailRefreshQueue, {
		maxJobs: args.maxJobs,
		preferredRowId: args.preferredRowId
	});
	return { scheduled: true, runtimeId: runtime._id };
}

function buildDetailRefreshQueueOutcomePatch(
	row: Doc<'detailRefreshQueue'>,
	args: {
		now: number;
		outcome: 'success' | 'retry' | 'error';
		nextAttemptAt?: number;
		nextRefreshAt?: number;
		lastError?: string;
		lastResultStatus?: string;
	}
): Partial<Doc<'detailRefreshQueue'>> {
	const patch: Partial<Doc<'detailRefreshQueue'>> = {
		lastFinishedAt: args.now,
		lastResultStatus: args.lastResultStatus
	};

	if (args.outcome === 'success') {
		const nextRefreshAt =
			args.nextRefreshAt ??
			row.nextRefreshAt ??
			args.now + DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS;
		patch.state = 'idle';
		patch.priority = DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY;
		patch.lastSuccessAt = args.now;
		patch.nextRefreshAt = nextRefreshAt;
		patch.nextAttemptAt = nextRefreshAt;
		patch.attemptCount = 0;
		patch.forceRefresh = false;
		patch.lastError = undefined;
		return patch;
	}

	if (args.outcome === 'retry') {
		patch.state = 'retry';
		patch.nextAttemptAt = args.nextAttemptAt ?? args.now + 60_000;
		patch.lastError = args.lastError;
		return patch;
	}

	patch.state = 'error';
	patch.nextAttemptAt =
		args.nextAttemptAt ??
		args.now + computeRefreshErrorBackoffMs(Math.max(1, row.attemptCount ?? 1));
	patch.lastError = args.lastError;
	return patch;
}

export async function upsertDetailRefreshQueueRequestHandler(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		priority: number;
		now: number;
		force?: boolean;
	}
) {
	return await requestDetailRefreshQueueRow(ctx, {
		mediaType: args.mediaType,
		source: args.source,
		externalId: args.externalId,
		now: args.now,
		priority: args.priority,
		force: args.force,
		staleRunningAfterMs: DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS
	});
}

export async function claimDetailRefreshQueueJobsHandler(
	ctx: MutationCtx,
	args: {
		now: number;
		maxJobs: number;
		mediaType?: 'movie' | 'tv';
		preferredRowId?: DetailRefreshQueueCandidate['_id'];
		activeTtlMs?: number;
	}
): Promise<ClaimedDetailRefreshQueueRow[]> {
	const runtime = await ensureDetailRefreshRuntimeRow(ctx);
	const activeTtlMs = Math.max(
		DETAIL_REFRESH_WORKER_SCHEDULE_DEBOUNCE_MS,
		args.activeTtlMs ?? DETAIL_REFRESH_WORKER_ACTIVE_TTL_MS
	);
	await ctx.db.patch(runtime._id, {
		lastWorkerStartedAt: args.now,
		workerActiveUntil: Math.max(runtime.workerActiveUntil ?? 0, args.now + activeTtlMs)
	});

	const maxJobs = Math.max(1, Math.min(args.maxJobs, 20));
	const claimed: ClaimedDetailRefreshQueueRow[] = [];
	const claimedRowIds = new Set<ClaimedDetailRefreshQueueRow['_id']>();

	if (args.preferredRowId && maxJobs > 0) {
		const preferredClaim = await tryClaimDetailRefreshQueueRow(ctx, {
			rowId: args.preferredRowId,
			now: args.now
		});
		if (preferredClaim) {
			claimed.push(preferredClaim);
			claimedRowIds.add(preferredClaim._id);
			if (claimed.length >= maxJobs) {
				return claimed;
			}
		}
	}

	const orderedCandidates = await collectDueDetailRefreshQueueCandidates(ctx, args);
	if (orderedCandidates.length === 0) return claimed;

	for (const candidate of orderedCandidates) {
		if (claimed.length >= maxJobs) break;
		if (claimedRowIds.has(candidate._id)) {
			continue;
		}
		const claim = await tryClaimDetailRefreshQueueRow(ctx, {
			rowId: candidate._id,
			now: args.now
		});
		if (!claim) continue;
		claimed.push(claim);
		claimedRowIds.add(claim._id);
	}

	return claimed;
}

export async function finishDetailRefreshQueueJobHandler(
	ctx: MutationCtx,
	args: {
		rowId: Doc<'detailRefreshQueue'>['_id'];
		now: number;
		outcome: 'success' | 'retry' | 'error';
		nextAttemptAt?: number;
		nextRefreshAt?: number;
		lastError?: string;
		lastResultStatus?: string;
	}
) {
	const row = await ctx.db.get(args.rowId);
	if (!row) return { ok: false };
	const patch = buildDetailRefreshQueueOutcomePatch(row, args);
	await ctx.db.patch(args.rowId, patch);
	return { ok: true };
}

export async function syncDetailRefreshQueueRowHandler(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		now: number;
		outcome: 'success' | 'retry' | 'error';
		nextAttemptAt?: number;
		nextRefreshAt?: number;
		lastError?: string;
		lastResultStatus?: string;
	}
) {
	const rowId = await ensureDetailRefreshQueueRow(ctx, {
		mediaType: args.mediaType,
		source: args.source,
		externalId: args.externalId,
		now: args.now,
		initialNextRefreshAt: args.nextRefreshAt ?? args.nextAttemptAt ?? args.now
	});
	const row = await ctx.db.get(rowId);
	if (!row) return { ok: false };
	const patch = buildDetailRefreshQueueOutcomePatch(row, args);
	await ctx.db.patch(rowId, patch);
	return { ok: true, rowId };
}

export async function scheduleDetailRefreshWorkerIfNeededHandler(
	ctx: MutationCtx,
	args: {
		now: number;
		maxJobs: number;
		delayMs?: number;
		activeTtlMs?: number;
		preferredRowId?: DetailRefreshQueueCandidate['_id'];
	}
) {
	const runtime = await ensureDetailRefreshRuntimeRow(ctx);
	const activeUntil = runtime.workerActiveUntil ?? 0;
	if (activeUntil > args.now) {
		return { scheduled: false, runtimeId: runtime._id };
	}
	return scheduleDetailRefreshWorkerRun(ctx, runtime, args);
}

export async function markDetailRefreshWorkerStartedHandler(
	ctx: MutationCtx,
	args: { now: number; activeTtlMs?: number }
) {
	const runtime = await ensureDetailRefreshRuntimeRow(ctx);
	const activeTtlMs = Math.max(
		DETAIL_REFRESH_WORKER_SCHEDULE_DEBOUNCE_MS,
		args.activeTtlMs ?? DETAIL_REFRESH_WORKER_ACTIVE_TTL_MS
	);
	await ctx.db.patch(runtime._id, {
		lastWorkerStartedAt: args.now,
		workerActiveUntil: Math.max(runtime.workerActiveUntil ?? 0, args.now + activeTtlMs)
	});
	return { ok: true, runtimeId: runtime._id };
}

export async function markDetailRefreshWorkerFinishedHandler(
	ctx: MutationCtx,
	args: { now: number }
) {
	const runtime = await ensureDetailRefreshRuntimeRow(ctx);
	await ctx.db.patch(runtime._id, {
		lastWorkerFinishedAt: args.now,
		workerActiveUntil: undefined
	});
	return { ok: true, runtimeId: runtime._id };
}

export async function finalizeDetailRefreshWorkerRunHandler(
	ctx: MutationCtx,
	args: {
		now: number;
		maxJobs: number;
		shouldContinueProcessing: boolean;
		preferredRowId?: DetailRefreshQueueCandidate['_id'];
		delayMs?: number;
		activeTtlMs?: number;
	}
) {
	const runtime = await ensureDetailRefreshRuntimeRow(ctx);
	const patch: Partial<DetailRefreshRuntimeDoc> = {
		lastWorkerFinishedAt: args.now
	};
	const shouldScheduleFollowUp =
		args.shouldContinueProcessing ||
		(await hasDueDetailRefreshQueueCandidates(ctx, {
			now: args.now
		}));

	if (shouldScheduleFollowUp) {
		await ctx.db.patch(runtime._id, patch);
		return {
			ok: true,
			...(await scheduleDetailRefreshWorkerRun(ctx, runtime, {
				now: args.now,
				maxJobs: args.maxJobs,
				delayMs: args.delayMs,
				activeTtlMs: args.activeTtlMs,
				preferredRowId: args.shouldContinueProcessing ? args.preferredRowId : undefined
			}))
		};
	}

	patch.workerActiveUntil = undefined;
	await ctx.db.patch(runtime._id, patch);
	return { ok: true, runtimeId: runtime._id, scheduled: false };
}

export async function pruneDetailRefreshQueueHandler(
	ctx: MutationCtx,
	args: { now: number; limit?: number }
) {
	const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
	const idleCutoff = args.now - 120 * 24 * 60 * 60_000;
	const errorCutoff = args.now - 45 * 24 * 60 * 60_000;
	const staleIds = new Set<Doc<'detailRefreshQueue'>['_id']>();

	const staleIdleBySuccess = await ctx.db
		.query('detailRefreshQueue')
		.withIndex('by_state_lastSuccessAt', (q) =>
			q.eq('state', 'idle').lte('lastSuccessAt', idleCutoff)
		)
		.take(limit);
	for (const row of staleIdleBySuccess) {
		if (staleIds.size >= limit) break;
		staleIds.add(row._id);
	}

	if (staleIds.size < limit) {
		const fallbackIdle = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_state_lastRequestedAt', (q) =>
				q.eq('state', 'idle').lte('lastRequestedAt', idleCutoff)
			)
			.take(limit * 2);
		for (const row of fallbackIdle) {
			if (staleIds.size >= limit) break;
			if ((row.lastSuccessAt ?? 0) > idleCutoff) continue;
			staleIds.add(row._id);
		}
	}

	if (staleIds.size < limit) {
		const staleErrorByFinished = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_state_lastFinishedAt', (q) =>
				q.eq('state', 'error').lte('lastFinishedAt', errorCutoff)
			)
			.take(limit);
		for (const row of staleErrorByFinished) {
			if (staleIds.size >= limit) break;
			staleIds.add(row._id);
		}
	}

	if (staleIds.size < limit) {
		const fallbackError = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_state_lastRequestedAt', (q) =>
				q.eq('state', 'error').lte('lastRequestedAt', errorCutoff)
			)
			.take(limit * 2);
		for (const row of fallbackError) {
			if (staleIds.size >= limit) break;
			if ((row.lastFinishedAt ?? 0) > errorCutoff) continue;
			staleIds.add(row._id);
		}
	}

	let deleted = 0;
	for (const rowId of staleIds) {
		await ctx.db.delete(rowId);
		deleted += 1;
	}
	return { deleted };
}

export async function listDetailRefreshQueueHandler(
	ctx: QueryCtx,
	args: {
		state?: 'idle' | 'queued' | 'running' | 'retry' | 'error';
		maxItems?: number;
		includeTotal?: boolean;
	}
) {
	const maxItems = Math.max(1, Math.min(args.maxItems ?? 200, 500));
	if (args.state) {
		const items = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_state_lastRequestedAt', (q) => q.eq('state', args.state!))
			.order('desc')
			.take(maxItems);
		if (args.includeTotal === true) {
			const total = (
				await ctx.db
					.query('detailRefreshQueue')
					.withIndex('by_state_lastRequestedAt', (q) => q.eq('state', args.state!))
					.collect()
			).length;
			return { items, total };
		}
		return { items, total: null };
	}

	const states = ['running', 'queued', 'retry', 'error', 'idle'] as const;
	const perState = await Promise.all(
		states.map((state) =>
			ctx.db
				.query('detailRefreshQueue')
				.withIndex('by_state_lastRequestedAt', (q) => q.eq('state', state))
				.order('desc')
				.take(maxItems)
		)
	);
	const merged = perState
		.flat()
		.sort((a, b) => (b.lastRequestedAt ?? 0) - (a.lastRequestedAt ?? 0))
		.slice(0, maxItems);
	return { items: merged, total: null };
}
