import type { Doc } from '../../_generated/dataModel';

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
