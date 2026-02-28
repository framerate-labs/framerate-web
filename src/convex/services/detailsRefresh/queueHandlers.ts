import type { Doc } from '../../_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from '../../_generated/server';
import type { RefreshCandidate } from '../../types/detailsType';

import { internal } from '../../_generated/api';
import {
	computeRefreshErrorBackoffMs,
	createDetailRefreshLeaseKey
} from '../detailsRefreshService';
import {
	DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY,
	DETAIL_REFRESH_QUEUE_FALLBACK_NEXT_REFRESH_MS
} from './constants';
import { isQueueUpsertResult, toRefreshCandidates } from './resultParsers';

function detailRefreshQueueKey(
	mediaType: 'movie' | 'tv',
	source: 'tmdb' | 'trakt' | 'imdb',
	externalId: number
): string {
	return `${source}:${mediaType}:${externalId}`;
}

export async function tryAcquireRefreshLeaseHandler(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		now: number;
		ttlMs: number;
		owner: string;
	}
) {
	const refreshKey = createDetailRefreshLeaseKey(args.mediaType, args.source, args.externalId);
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
			mediaType: args.mediaType,
			source: args.source,
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

export async function releaseRefreshLeaseHandler(
	ctx: MutationCtx,
	args: { leaseId: Doc<'detailRefreshLeases'>['_id']; owner: string }
) {
	const lease = await ctx.db.get(args.leaseId);
	if (!lease) return;
	if (lease.owner !== args.owner) return;
	await ctx.db.delete(args.leaseId);
}

export async function pruneExpiredRefreshLeasesHandler(
	ctx: MutationCtx,
	args: { now: number; limit: number }
) {
	const expired = await ctx.db
		.query('detailRefreshLeases')
		.withIndex('by_leaseExpiresAt', (q) => q.lte('leaseExpiresAt', args.now))
		.take(args.limit);

	for (const lease of expired) {
		await ctx.db.delete(lease._id);
	}

	return { pruned: expired.length };
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

export async function enqueueStaleDetailRefreshQueueJobsHandler(
	ctx: ActionCtx,
	args: { now: number; limit?: number; limitPerType?: number; priority?: number }
) {
	const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
	const limitPerType = Math.max(10, Math.min(args.limitPerType ?? 200, 500));
	const priority = args.priority ?? DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY;
	const candidates = await ctx.runQuery(internal.detailsRefresh.listStaleRefreshCandidates, {
		now: args.now,
		limitPerType
	});
	const selected = toRefreshCandidates(candidates).slice(0, limit);
	const scanned = selected.length;
	const deduped: RefreshCandidate[] = [];
	const seenKeys = new Set<string>();
	for (const candidate of selected) {
		const key = detailRefreshQueueKey(candidate.mediaType, 'tmdb', candidate.id);
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);
		deduped.push(candidate);
	}
	let queued = 0;
	for (const candidate of deduped) {
		const outcome = await ctx.runMutation(internal.detailsRefresh.upsertDetailRefreshQueueRequest, {
			mediaType: candidate.mediaType,
			source: 'tmdb',
			externalId: candidate.id,
			priority,
			now: args.now,
			force: false
		});
		if (isQueueUpsertResult(outcome) && outcome.queued) queued += 1;
	}
	return { scanned, queued };
}

export async function claimNextDetailRefreshQueueJobHandler(
	ctx: MutationCtx,
	args: { now: number; mediaType?: 'movie' | 'tv' }
) {
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
	let selected: Doc<'detailRefreshQueue'> | null = null;
	for (const candidate of candidates) {
		if (!selected) {
			selected = candidate;
			continue;
		}
		const byPriority = candidate.priority - selected.priority;
		if (byPriority > 0) {
			selected = candidate;
			continue;
		}
		if (byPriority < 0) continue;
		const byAttempt = (candidate.nextAttemptAt ?? 0) - (selected.nextAttemptAt ?? 0);
		if (byAttempt < 0) {
			selected = candidate;
			continue;
		}
		if (byAttempt > 0) continue;
		const byRequested = (candidate.requestedAt ?? 0) - (selected.requestedAt ?? 0);
		if (byRequested < 0) {
			selected = candidate;
		}
	}
	if (!selected) return null;
	const selectedId = selected._id;
	const rowsForSyncKey = await ctx.db
		.query('detailRefreshQueue')
		.withIndex('by_syncKey', (q) => q.eq('syncKey', selected.syncKey))
		.collect();
	const activeRunning = rowsForSyncKey.find(
		(row) => row.state === 'running' && row._id !== selectedId
	);
	if (activeRunning) {
		for (const row of rowsForSyncKey) {
			if (row._id === activeRunning._id) continue;
			await ctx.db.delete(row._id);
		}
		return null;
	}
	for (const row of rowsForSyncKey) {
		if (row._id === selected._id) continue;
		await ctx.db.delete(row._id);
	}
	const freshSelected = await ctx.db.get(selected._id);
	if (!freshSelected) return null;
	if (freshSelected.state === 'running') return null;
	if (
		(freshSelected.state !== 'queued' && freshSelected.state !== 'retry') ||
		(freshSelected.nextAttemptAt ?? 0) > args.now
	) {
		return null;
	}
	const nextAttemptCount = (freshSelected.attemptCount ?? 0) + 1;
	await ctx.db.patch(freshSelected._id, {
		state: 'running',
		lastStartedAt: args.now,
		attemptCount: nextAttemptCount,
		lastError: undefined
	});
	return {
		...freshSelected,
		state: 'running' as const,
		attemptCount: nextAttemptCount
	};
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

export async function listStaleRefreshCandidatesHandler(
	ctx: QueryCtx,
	args: { now: number; limitPerType: number }
): Promise<RefreshCandidate[]> {
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
		.map((movie): RefreshCandidate | null => {
			if (typeof movie.tmdbId !== 'number') return null;
			return {
				mediaType: 'movie',
				id: movie.tmdbId,
				nextRefreshAt: movie.nextRefreshAt ?? 0
			};
		})
		.filter((candidate): candidate is RefreshCandidate => candidate !== null);

	const tvCandidates: RefreshCandidate[] = tvShows
		.map((tvShow): RefreshCandidate | null => {
			if (typeof tvShow.tmdbId !== 'number') return null;
			return {
				mediaType: 'tv',
				id: tvShow.tmdbId,
				nextRefreshAt: tvShow.nextRefreshAt ?? 0
			};
		})
		.filter((candidate): candidate is RefreshCandidate => candidate !== null);

	return [...movieCandidates, ...tvCandidates].sort((a, b) => a.nextRefreshAt - b.nextRefreshAt);
}
