import type {
	AniListRateLimitHints,
	AniListRequestKind,
	AniListRequestMetrics
} from '../../types/anilistTypes';

export function createAniListRequestMetrics(): AniListRequestMetrics {
	return {
		requestAttempts: 0,
		rateLimitedResponses: 0,
		retries: 0,
		searchRequests: 0,
		mediaRequests: 0,
		lastRateLimitLimit: null,
		lastRateLimitRemaining: null,
		minRateLimitRemaining: null,
		lastRateLimitResetAtMs: null,
		lastRetryAfterMs: null
	};
}

function parseHeaderNumber(value: string | null, options?: { min?: number }): number | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	const min = options?.min ?? 0;
	if (parsed < min) return null;
	return parsed;
}

function parseAniListResetHeaderMs(value: string | null): number | null {
	const parsed = parseHeaderNumber(value, { min: 1 });
	if (parsed == null) return null;
	// AniList docs report Unix timestamp (seconds). Be defensive if milliseconds are returned.
	return parsed >= 1_000_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
}

export function recordAniListAttempt(
	metrics: AniListRequestMetrics | undefined,
	kind: AniListRequestKind
) {
	if (!metrics) return;
	metrics.requestAttempts += 1;
	if (kind === 'search') metrics.searchRequests += 1;
	else metrics.mediaRequests += 1;
}

export function recordAniListRateLimitHeaders(
	metrics: AniListRequestMetrics | undefined,
	response: Response
) {
	if (!metrics) return;
	const limit = parseHeaderNumber(response.headers.get('x-ratelimit-limit'), { min: 1 });
	if (limit != null) metrics.lastRateLimitLimit = Math.floor(limit);

	const remaining = parseHeaderNumber(response.headers.get('x-ratelimit-remaining'), { min: 0 });
	if (remaining != null) {
		const normalized = Math.max(0, Math.floor(remaining));
		metrics.lastRateLimitRemaining = normalized;
		metrics.minRateLimitRemaining =
			metrics.minRateLimitRemaining == null
				? normalized
				: Math.min(metrics.minRateLimitRemaining, normalized);
	}

	const resetAtMs = parseAniListResetHeaderMs(response.headers.get('x-ratelimit-reset'));
	if (resetAtMs != null) metrics.lastRateLimitResetAtMs = resetAtMs;

	const retryAfterSeconds = parseHeaderNumber(response.headers.get('retry-after'), { min: 0 });
	if (retryAfterSeconds != null) {
		metrics.lastRetryAfterMs = Math.max(1000, Math.floor(retryAfterSeconds * 1000));
	}
}

export function summarizeAniListRateLimitHints(
	metrics: AniListRequestMetrics
): AniListRateLimitHints | null {
	const hints: AniListRateLimitHints = {};
	if (
		typeof metrics.lastRateLimitLimit === 'number' &&
		Number.isFinite(metrics.lastRateLimitLimit)
	) {
		hints.limit = Math.max(1, Math.floor(metrics.lastRateLimitLimit));
	}
	const remainingCandidate =
		typeof metrics.minRateLimitRemaining === 'number' &&
		Number.isFinite(metrics.minRateLimitRemaining)
			? metrics.minRateLimitRemaining
			: metrics.lastRateLimitRemaining;
	if (typeof remainingCandidate === 'number' && Number.isFinite(remainingCandidate)) {
		hints.remaining = Math.max(0, Math.floor(remainingCandidate));
	}
	if (
		typeof metrics.lastRateLimitResetAtMs === 'number' &&
		Number.isFinite(metrics.lastRateLimitResetAtMs)
	) {
		hints.resetAtMs = Math.max(0, Math.floor(metrics.lastRateLimitResetAtMs));
	}
	if (typeof metrics.lastRetryAfterMs === 'number' && Number.isFinite(metrics.lastRetryAfterMs)) {
		hints.retryAfterMs = Math.max(1000, Math.floor(metrics.lastRetryAfterMs));
	}
	return Object.keys(hints).length > 0 ? hints : null;
}
