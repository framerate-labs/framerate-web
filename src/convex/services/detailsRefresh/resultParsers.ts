import type { Doc } from '../../_generated/dataModel';
import type { RefreshCandidate, RefreshIfStaleResult } from '../../types/detailsType';

export type QueueUpsertResult = {
	queued: boolean;
	inserted: boolean;
	rowId: Doc<'detailRefreshQueue'>['_id'];
};

export type AnimeSeasonEnqueueStatus = {
	found: boolean;
	isAnime: boolean | null;
	shouldEnqueue: boolean;
};

export type ProcessQueueResult = {
	ok: boolean;
	processed: number;
	refreshed: number;
	skipped: number;
	failed: number;
	deferred: number;
};

export function toQueueSweepSummary(value: unknown): { scanned: number; queued: number } {
	if (!value || typeof value !== 'object') {
		return { scanned: 0, queued: 0 };
	}
	const row = value as Record<string, unknown>;
	return {
		scanned: numberOrZero(row.scanned),
		queued: numberOrZero(row.queued)
	};
}

export function toProcessQueueSummary(value: unknown): ProcessQueueResult {
	if (!value || typeof value !== 'object') {
		return { ok: false, processed: 0, refreshed: 0, skipped: 0, failed: 0, deferred: 0 };
	}
	const row = value as Record<string, unknown>;
	return {
		ok: row.ok === true,
		processed: numberOrZero(row.processed),
		refreshed: numberOrZero(row.refreshed),
		skipped: numberOrZero(row.skipped),
		failed: numberOrZero(row.failed),
		deferred: numberOrZero(row.deferred)
	};
}

export function toRefreshCandidates(value: unknown): RefreshCandidate[] {
	if (!Array.isArray(value)) return [];
	const candidates: RefreshCandidate[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		const mediaType = row.mediaType;
		const id = row.id;
		const nextRefreshAt = row.nextRefreshAt;
		if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof id !== 'number') continue;
		if (typeof nextRefreshAt !== 'number') continue;
		candidates.push({ mediaType, id, nextRefreshAt });
	}
	return candidates;
}

export function toRefreshIfStaleResult(value: unknown): RefreshIfStaleResult {
	if (!value || typeof value !== 'object') {
		return { refreshed: false, reason: 'invalid_result', nextRefreshAt: null };
	}
	const row = value as Record<string, unknown>;
	return {
		refreshed: row.refreshed === true,
		reason: typeof row.reason === 'string' ? row.reason : 'invalid_result',
		nextRefreshAt: typeof row.nextRefreshAt === 'number' ? row.nextRefreshAt : null
	};
}

export function isQueueUpsertResult(value: unknown): value is QueueUpsertResult {
	if (!value || typeof value !== 'object') return false;
	const row = value as Record<string, unknown>;
	return typeof row.queued === 'boolean' && typeof row.inserted === 'boolean' && row.rowId != null;
}

export function toAnimeSeasonEnqueueStatus(value: unknown): AnimeSeasonEnqueueStatus {
	if (!value || typeof value !== 'object') {
		return { found: false, isAnime: null, shouldEnqueue: false };
	}
	const row = value as Record<string, unknown>;
	return {
		found: row.found === true,
		isAnime: typeof row.isAnime === 'boolean' ? row.isAnime : null,
		shouldEnqueue: row.shouldEnqueue === true
	};
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
