import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

import { DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY } from './constants';

export type DetailRefreshQueueDoc = Doc<'detailRefreshQueue'>;

export function detailRefreshQueueKey(
	mediaType: 'movie' | 'tv',
	source: 'tmdb' | 'trakt' | 'imdb',
	externalId: number
): string {
	return `${source}:${mediaType}:${externalId}`;
}

export function isStaleRunningDetailQueueRow(
	row: Pick<DetailRefreshQueueDoc, 'state' | 'lastStartedAt' | 'lastRequestedAt'>,
	now: number,
	staleAfterMs: number
): boolean {
	if (row.state !== 'running') return false;
	const startedAt = row.lastStartedAt ?? row.lastRequestedAt ?? 0;
	return startedAt > 0 && startedAt + staleAfterMs <= now;
}

export async function getCanonicalDetailRefreshQueueRow(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
	}
): Promise<DetailRefreshQueueDoc | null> {
	return await ctx.db
		.query('detailRefreshQueue')
		.withIndex('by_syncKey', (q) =>
			q.eq('syncKey', detailRefreshQueueKey(args.mediaType, args.source, args.externalId))
		)
		.unique();
}

export async function ensureDetailRefreshQueueRow(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		now: number;
		initialNextRefreshAt?: number;
	}
): Promise<DetailRefreshQueueDoc['_id']> {
	const existing = await getCanonicalDetailRefreshQueueRow(ctx, args);
	const nextRefreshAt = args.initialNextRefreshAt ?? args.now;

	if (!existing) {
		return await ctx.db.insert('detailRefreshQueue', {
			syncKey: detailRefreshQueueKey(args.mediaType, args.source, args.externalId),
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId,
			state: 'idle',
			priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY,
			requestedAt: args.now,
			lastRequestedAt: args.now,
			nextAttemptAt: nextRefreshAt,
			attemptCount: 0,
			forceRefresh: false,
			nextRefreshAt
		});
	}

	const patch: Partial<DetailRefreshQueueDoc> = {};
	if (existing.nextRefreshAt == null) {
		patch.nextRefreshAt = nextRefreshAt;
	}
	if (existing.nextAttemptAt == null) {
		patch.nextAttemptAt = nextRefreshAt;
	}
	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}
	return existing._id;
}

export async function requestDetailRefreshQueueRow(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		now: number;
		priority: number;
		force?: boolean;
		staleRunningAfterMs: number;
	}
): Promise<{ queued: boolean; inserted: boolean; rowId: DetailRefreshQueueDoc['_id'] }> {
	const existing = await getCanonicalDetailRefreshQueueRow(ctx, args);
	const force = args.force === true;

	if (!existing) {
		const rowId = await ctx.db.insert('detailRefreshQueue', {
			syncKey: detailRefreshQueueKey(args.mediaType, args.source, args.externalId),
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId,
			state: 'queued',
			priority: args.priority,
			requestedAt: args.now,
			lastRequestedAt: args.now,
			nextAttemptAt: args.now,
			attemptCount: 0,
			forceRefresh: force,
			nextRefreshAt: args.now
		});
		return { queued: true, inserted: true, rowId };
	}

	const isStaleRunning = isStaleRunningDetailQueueRow(
		existing,
		args.now,
		args.staleRunningAfterMs
	);
	if (existing.state === 'running' && !isStaleRunning) {
		return { queued: false, inserted: false, rowId: existing._id };
	}

	const nextPriority = Math.max(existing.priority, args.priority);
	const nextAttemptAt = Math.min(existing.nextAttemptAt ?? args.now, args.now);
	const patch: Partial<DetailRefreshQueueDoc> = {};

	if (existing.state !== 'queued') {
		patch.state = 'queued';
		patch.lastRequestedAt = args.now;
	}
	if (force && (existing.lastRequestedAt ?? 0) !== args.now) {
		patch.lastRequestedAt = args.now;
	}
	if (nextPriority !== existing.priority) {
		patch.priority = nextPriority;
	}
	if (nextAttemptAt !== existing.nextAttemptAt) {
		patch.nextAttemptAt = nextAttemptAt;
	}
	if (force && existing.forceRefresh !== true) {
		patch.forceRefresh = true;
	}
	if (existing.lastError !== undefined) {
		patch.lastError = undefined;
	}

	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
		return { queued: true, inserted: false, rowId: existing._id };
	}

	return { queued: false, inserted: false, rowId: existing._id };
}
