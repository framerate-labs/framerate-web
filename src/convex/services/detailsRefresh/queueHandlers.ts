import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

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
		args.nextAttemptAt ?? args.now + computeRefreshErrorBackoffMs(Math.max(1, row.attemptCount ?? 1));
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

export async function claimNextDetailRefreshQueueJobHandler(
	ctx: MutationCtx,
	args: { now: number; mediaType?: 'movie' | 'tv' }
) {
	function compareQueueCandidates(
		left: Doc<'detailRefreshQueue'>,
		right: Doc<'detailRefreshQueue'>
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

	const candidates = new Map<Doc<'detailRefreshQueue'>['_id'], Doc<'detailRefreshQueue'>>();
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
	const orderedCandidates = [...candidates.values()];
	if (orderedCandidates.length === 0) return null;
	orderedCandidates.sort(compareQueueCandidates);

	for (const candidate of orderedCandidates) {
		const freshCandidate = await ctx.db.get(candidate._id);
		if (!freshCandidate) continue;
		if (freshCandidate.state === 'running') {
			if (isStaleRunningDetailQueueRow(freshCandidate, args.now, DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS)) {
				await ctx.db.patch(freshCandidate._id, {
					state: 'queued',
					nextAttemptAt: Math.min(freshCandidate.nextAttemptAt ?? args.now, args.now),
					lastRequestedAt: args.now
				});
			}
			continue;
		}
		if (
			(freshCandidate.state !== 'queued' &&
				freshCandidate.state !== 'retry' &&
				freshCandidate.state !== 'idle') ||
			(freshCandidate.nextAttemptAt ?? 0) > args.now
		) {
			continue;
		}
		const nextAttemptCount = (freshCandidate.attemptCount ?? 0) + 1;
		await ctx.db.patch(freshCandidate._id, {
			state: 'running',
			lastStartedAt: args.now,
			attemptCount: nextAttemptCount,
			lastError: undefined
		});
		return {
			...freshCandidate,
			state: 'running' as const,
			attemptCount: nextAttemptCount
		};
	}

	return null;
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
