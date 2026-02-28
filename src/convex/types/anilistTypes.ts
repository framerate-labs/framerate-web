export type AniListGraphQLError = {
	message?: string;
	status?: number;
};

export type AniListGraphQLResponse<T> = {
	data?: T;
	errors?: AniListGraphQLError[];
};

export type AniListRequestMetrics = {
	requestAttempts: number;
	rateLimitedResponses: number;
	retries: number;
	searchRequests: number;
	mediaRequests: number;
	lastRateLimitLimit?: number | null;
	lastRateLimitRemaining?: number | null;
	minRateLimitRemaining?: number | null;
	lastRateLimitResetAtMs?: number | null;
	lastRetryAfterMs?: number | null;
};

export type AniListRateLimitHints = {
	limit?: number;
	remaining?: number;
	resetAtMs?: number;
	retryAfterMs?: number;
};

export type AniListRequestKind = 'search' | 'media';
