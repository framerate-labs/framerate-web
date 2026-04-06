import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

import { DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY } from './constants';
import { coverageRank } from '../../utils/details/credits';
import {
	detailRefreshQueueKey,
	isStaleRunningDetailQueueRow
} from './queueState';

const DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS = 20 * 60_000;

type MoviesOrTVTable = 'movies' | 'tvShows';

type BackfillQueuePageResult = {
	scanned: number;
	created: number;
	cursor: string | null;
	isDone: boolean;
};

function normalizePageSize(limit: number | undefined, fallback: number, max: number): number {
	return Math.max(1, Math.min(limit ?? fallback, max));
}

function queueStateRank(state: Doc<'detailRefreshQueue'>['state']): number {
	switch (state) {
		case 'running':
			return 5;
		case 'queued':
			return 4;
		case 'retry':
			return 3;
		case 'idle':
			return 2;
		case 'error':
			return 1;
	}
}

function isBetterQueueCanonicalCandidate(
	candidate: Doc<'detailRefreshQueue'>,
	current: Doc<'detailRefreshQueue'> | null
): boolean {
	if (!current) return true;
	const byState = queueStateRank(candidate.state) - queueStateRank(current.state);
	if (byState !== 0) return byState > 0;
	const byRequest = (candidate.lastRequestedAt ?? 0) - (current.lastRequestedAt ?? 0);
	if (byRequest !== 0) return byRequest > 0;
	return candidate._creationTime > current._creationTime;
}

function minNullableNumber(...values: Array<number | null | undefined>): number | undefined {
	let next: number | undefined;
	for (const value of values) {
		if (typeof value !== 'number') continue;
		next = next === undefined ? value : Math.min(next, value);
	}
	return next;
}

function maxNullableNumber(...values: Array<number | null | undefined>): number | undefined {
	let next: number | undefined;
	for (const value of values) {
		if (typeof value !== 'number') continue;
		next = next === undefined ? value : Math.max(next, value);
	}
	return next;
}

function latestDefinedString(
	rows: Doc<'detailRefreshQueue'>[],
	field: 'lastError' | 'lastResultStatus'
): string | undefined {
	let latestValue: string | undefined;
	let latestAt = -1;
	for (const row of rows) {
		const value = row[field];
		if (typeof value !== 'string' || value.length === 0) continue;
		const timestamp = row.lastFinishedAt ?? row.lastRequestedAt ?? row._creationTime;
		if (timestamp > latestAt) {
			latestValue = value;
			latestAt = timestamp;
		}
	}
	return latestValue;
}

function buildQueueRepairPatch(
	canonical: Doc<'detailRefreshQueue'>,
	rows: Doc<'detailRefreshQueue'>[],
	now: number
): Partial<Doc<'detailRefreshQueue'>> {
	let state = canonical.state;
	if (state === 'running' && isStaleRunningDetailQueueRow(canonical, now, DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS)) {
		state = 'queued';
	}

	const nextPriority = rows.reduce(
		(maxPriority, row) => Math.max(maxPriority, row.priority),
		canonical.priority
	);
	const nextRequestedAt =
		minNullableNumber(...rows.map((row) => row.requestedAt)) ?? canonical.requestedAt;
	const nextLastRequestedAt =
		maxNullableNumber(...rows.map((row) => row.lastRequestedAt)) ?? canonical.lastRequestedAt;
	const nextAttemptAt =
		minNullableNumber(...rows.map((row) => row.nextAttemptAt)) ?? canonical.nextAttemptAt;
	const nextAttemptCount =
		state === 'idle' ? 0 : Math.max(...rows.map((row) => row.attemptCount ?? 0));
	const nextForceRefresh =
		state === 'idle' ? false : rows.some((row) => row.forceRefresh === true);
	const nextLastStartedAt = maxNullableNumber(...rows.map((row) => row.lastStartedAt));
	const nextLastFinishedAt = maxNullableNumber(...rows.map((row) => row.lastFinishedAt));
	const nextLastSuccessAt = maxNullableNumber(...rows.map((row) => row.lastSuccessAt));
	const nextRefreshAt =
		minNullableNumber(...rows.map((row) => row.nextRefreshAt)) ?? canonical.nextRefreshAt;
	const nextLastError = state === 'idle' ? undefined : latestDefinedString(rows, 'lastError');
	const nextLastResultStatus = latestDefinedString(rows, 'lastResultStatus');

	const patch: Partial<Doc<'detailRefreshQueue'>> = {};
	if (state !== canonical.state) patch.state = state;
	if (nextPriority !== canonical.priority) patch.priority = nextPriority;
	if (nextRequestedAt !== canonical.requestedAt) patch.requestedAt = nextRequestedAt;
	if (nextLastRequestedAt !== canonical.lastRequestedAt) patch.lastRequestedAt = nextLastRequestedAt;
	if (nextAttemptAt !== canonical.nextAttemptAt) patch.nextAttemptAt = nextAttemptAt;
	if (nextAttemptCount !== (canonical.attemptCount ?? 0)) patch.attemptCount = nextAttemptCount;
	if (nextForceRefresh !== (canonical.forceRefresh === true)) patch.forceRefresh = nextForceRefresh;
	if (nextLastStartedAt !== canonical.lastStartedAt) patch.lastStartedAt = nextLastStartedAt;
	if (nextLastFinishedAt !== canonical.lastFinishedAt) patch.lastFinishedAt = nextLastFinishedAt;
	if (nextLastSuccessAt !== canonical.lastSuccessAt) patch.lastSuccessAt = nextLastSuccessAt;
	if (nextRefreshAt !== canonical.nextRefreshAt) patch.nextRefreshAt = nextRefreshAt;
	if (nextLastError !== canonical.lastError) patch.lastError = nextLastError;
	if (nextLastResultStatus !== canonical.lastResultStatus) {
		patch.lastResultStatus = nextLastResultStatus;
	}
	return patch;
}

function buildCreditCacheKey(row: Doc<'creditCache'>): string {
	return `${row.mediaType}:${row.tmdbId}:${row.source}:${row.seasonKey ?? ''}`;
}

function isBetterCreditCacheCanonicalCandidate(
	candidate: Doc<'creditCache'>,
	current: Doc<'creditCache'> | null
): boolean {
	if (!current) return true;
	const byCoverage = coverageRank(candidate.coverage) - coverageRank(current.coverage);
	if (byCoverage !== 0) return byCoverage > 0;
	if (candidate.fetchedAt !== current.fetchedAt) {
		return candidate.fetchedAt > current.fetchedAt;
	}
	return candidate._creationTime > current._creationTime;
}

export async function backfillMissingDetailRefreshQueueRowsPageHandler(
	ctx: MutationCtx,
	args: {
		table: MoviesOrTVTable;
		now: number;
		limit?: number;
		cursor?: string | null;
	}
): Promise<BackfillQueuePageResult> {
	const pageSize = normalizePageSize(args.limit, 200, 500);
	const page = await ctx.db.query(args.table).order('asc').paginate({
		numItems: pageSize,
		cursor: args.cursor ?? null
	});
	let created = 0;

	for (const row of page.page) {
		const tmdbId = row.tmdbId;
		if (typeof tmdbId !== 'number') continue;
		const mediaType = args.table === 'movies' ? 'movie' : 'tv';
		const syncKey = detailRefreshQueueKey(mediaType, 'tmdb', tmdbId);
		const existingRows = await ctx.db
			.query('detailRefreshQueue')
			.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
			.take(2);
		const initialNextRefreshAt = row.nextRefreshAt ?? args.now;
		if (existingRows.length === 0) {
			created += 1;
			await ctx.db.insert('detailRefreshQueue', {
				syncKey,
				mediaType,
				source: 'tmdb',
				externalId: tmdbId,
				state: 'idle',
				priority: DETAIL_REFRESH_QUEUE_BACKGROUND_PRIORITY,
				requestedAt: args.now,
				lastRequestedAt: args.now,
				nextAttemptAt: initialNextRefreshAt,
				attemptCount: 0,
				forceRefresh: false,
				nextRefreshAt: initialNextRefreshAt
			});
			continue;
		}
		const canonical = existingRows[0];
		if (!canonical) continue;
		const patch: Partial<Doc<'detailRefreshQueue'>> = {};
		if (canonical.nextRefreshAt == null) {
			patch.nextRefreshAt = initialNextRefreshAt;
		}
		if (canonical.nextAttemptAt == null) {
			patch.nextAttemptAt = initialNextRefreshAt;
		}
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(canonical._id, patch);
		}
	}

	return {
		scanned: page.page.length,
		created,
		cursor: page.continueCursor,
		isDone: page.isDone
	};
}

export async function repairDetailRefreshArtifactsHandler(
	ctx: MutationCtx,
	args: { now: number }
): Promise<{
	queueRowsDeleted: number;
	queueRowsPatched: number;
	creditRowsDeleted: number;
	creditRowsPatched: number;
}> {
	let queueRowsDeleted = 0;
	let queueRowsPatched = 0;
	const queueRows = await ctx.db.query('detailRefreshQueue').withIndex('by_syncKey').collect();
	const queueGroups = new Map<string, Doc<'detailRefreshQueue'>[]>();
	for (const row of queueRows) {
		const existing = queueGroups.get(row.syncKey) ?? [];
		existing.push(row);
		queueGroups.set(row.syncKey, existing);
	}
	for (const rows of queueGroups.values()) {
		if (rows.length === 0) continue;
		let canonical: Doc<'detailRefreshQueue'> | null = null;
		for (const row of rows) {
			if (isBetterQueueCanonicalCandidate(row, canonical)) {
				canonical = row;
			}
		}
		if (!canonical) continue;
		const patch = buildQueueRepairPatch(canonical, rows, args.now);
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(canonical._id, patch);
			queueRowsPatched += 1;
		}
		for (const row of rows) {
			if (row._id === canonical._id) continue;
			await ctx.db.delete(row._id);
			queueRowsDeleted += 1;
		}
	}

	let creditRowsDeleted = 0;
	let creditRowsPatched = 0;
	const creditRows = await ctx.db.query('creditCache').withIndex('by_nextRefreshAt').collect();
	const creditGroups = new Map<string, Doc<'creditCache'>[]>();
	for (const row of creditRows) {
		const key = buildCreditCacheKey(row);
		const existing = creditGroups.get(key) ?? [];
		existing.push(row);
		creditGroups.set(key, existing);
	}
	for (const rows of creditGroups.values()) {
		if (rows.length === 0) continue;
		let canonical: Doc<'creditCache'> | null = null;
		for (const row of rows) {
			if (isBetterCreditCacheCanonicalCandidate(row, canonical)) {
				canonical = row;
			}
		}
		if (!canonical) continue;
		const latestFetchedAt = maxNullableNumber(...rows.map((row) => row.fetchedAt)) ?? canonical.fetchedAt;
		const earliestNextRefreshAt =
			minNullableNumber(...rows.map((row) => row.nextRefreshAt)) ?? canonical.nextRefreshAt;
		if (canonical.fetchedAt !== latestFetchedAt || canonical.nextRefreshAt !== earliestNextRefreshAt) {
			await ctx.db.patch(canonical._id, {
				fetchedAt: latestFetchedAt,
				nextRefreshAt: earliestNextRefreshAt
			});
			creditRowsPatched += 1;
		}
		for (const row of rows) {
			if (row._id === canonical._id) continue;
			await ctx.db.delete(row._id);
			creditRowsDeleted += 1;
		}
	}

	return {
		queueRowsDeleted,
		queueRowsPatched,
		creditRowsDeleted,
		creditRowsPatched
	};
}
