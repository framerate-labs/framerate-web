import { daysSinceDate, daysToMs, daysUntilDate } from './dateUtils';

export type StoredAnimeRefreshSignals = {
	found: boolean;
	isAnime: boolean | null;
	isAnimeSource: 'auto' | 'manual' | null;
	status: string | null;
	lastAirDate: string | null;
	lastEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	nextEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	releaseDate: string | null;
};

const ANIME_SYNC_JOB_DEFAULTS = {
	season: { cost: 12, priority: 40 },
	timeline: { cost: 48, priority: 10 }
} as const;
export type AnimeSyncJobType = keyof typeof ANIME_SYNC_JOB_DEFAULTS;
export const ANIME_SYNC_QUEUE_BACKGROUND_SEASON_PRIORITY = ANIME_SYNC_JOB_DEFAULTS.season.priority;
export const ANIME_SYNC_QUEUE_TIMELINE_PRIORITY = ANIME_SYNC_JOB_DEFAULTS.timeline.priority;
const ANILIST_STATED_LIMIT_PER_MIN = 90;
const ANILIST_TARGET_BUDGET_FACTOR = 0.6;
const ANILIST_MIN_THROTTLE_FACTOR = 0.2;

export const ANILIST_BASE_BUDGET_PER_MIN = Math.max(
	1,
	Math.floor(ANILIST_STATED_LIMIT_PER_MIN * ANILIST_TARGET_BUDGET_FACTOR)
);

export type AniListBudgetSnapshot = {
	tokens?: number;
	baseCapacity?: number;
	refillPerMinute?: number;
	throttleFactor?: number;
	lastRefillAt?: number;
};

export type AniListBudgetWindow = {
	baseCapacity: number;
	baseRefill: number;
	throttleFactor: number;
	effectiveCapacity: number;
	effectiveRefill: number;
	refilledTokens: number;
};

function computeSeasonRefreshTtlMs(now: number, signals: StoredAnimeRefreshSignals): number {
	const daysUntilNext = daysUntilDate(now, signals.nextEpisodeToAir?.airDate ?? null);
	const daysSinceLastEpisode = daysSinceDate(now, signals.lastEpisodeToAir?.airDate ?? null);
	const daysSinceLastAir = daysSinceDate(now, signals.lastAirDate);
	const status = (signals.status ?? '').toLowerCase();
	const isEnded =
		status.includes('ended') || status.includes('canceled') || status.includes('cancelled');

	if (daysUntilNext != null) {
		if (daysUntilNext <= 14) return daysToMs(7);
		if (daysUntilNext <= 30) return daysToMs(14);
		if (daysUntilNext <= 60) return daysToMs(30);
		if (daysUntilNext <= 120) return daysToMs(60);
		return daysToMs(120);
	}
	if (daysSinceLastEpisode != null) {
		if (daysSinceLastEpisode <= 30) return daysToMs(30);
		if (daysSinceLastEpisode <= 90) return daysToMs(60);
	}
	if (isEnded && daysSinceLastAir != null) {
		if (daysSinceLastAir <= 60) return daysToMs(30);
		if (daysSinceLastAir <= 365) return daysToMs(180);
		return daysToMs(365);
	}
	return daysToMs(90);
}

export function createAnimeSyncLeaseOwner(now = Date.now()): string {
	return `anime-sync:${now}:${Math.random().toString(36).slice(2, 10)}`;
}

export function animeSeedSweepLeaseKey(table: 'tvShows' | 'movies'): string {
	return `seed_sweep:${table}`;
}

export function animeSyncQueueKey(
	jobType: AnimeSyncJobType,
	tmdbType: 'movie' | 'tv',
	tmdbId: number
): string {
	return `${jobType}:${tmdbType}:${tmdbId}`;
}

export function animeTitleSyncLeaseKey(
	jobType: AnimeSyncJobType,
	tmdbType: 'movie' | 'tv',
	tmdbId: number
): string {
	return `title_sync:${jobType}:${tmdbType}:${tmdbId}`;
}

export function animeSyncQueueDefaultPriority(jobType: AnimeSyncJobType): number {
	return ANIME_SYNC_JOB_DEFAULTS[jobType].priority;
}

export function animeSyncJobDefaultCost(jobType: AnimeSyncJobType): number {
	return ANIME_SYNC_JOB_DEFAULTS[jobType].cost;
}

export function normalizeAniListCost(
	estimatedAniListCost: number | undefined,
	jobType: AnimeSyncJobType
): number {
	return Math.max(1, Math.ceil(estimatedAniListCost ?? animeSyncJobDefaultCost(jobType)));
}

export function computeAnimeQueueRefreshTtlMs(
	now: number,
	jobType: AnimeSyncJobType,
	signals: StoredAnimeRefreshSignals
): number {
	if (jobType === 'timeline') return daysToMs(30);
	return computeSeasonRefreshTtlMs(now, signals);
}

export function clampAniListThrottleFactor(value: number): number {
	return Math.max(ANILIST_MIN_THROTTLE_FACTOR, Math.min(1, value));
}

export function computeAniListBudgetWindow(
	now: number,
	budgetRow: AniListBudgetSnapshot | null | undefined,
	overrides?: { baseCapacity?: number; baseRefill?: number; throttleFactor?: number }
): AniListBudgetWindow {
	const baseCapacity = Math.max(
		1,
		Math.floor(overrides?.baseCapacity ?? budgetRow?.baseCapacity ?? ANILIST_BASE_BUDGET_PER_MIN)
	);
	const baseRefill = Math.max(
		1,
		Math.floor(overrides?.baseRefill ?? budgetRow?.refillPerMinute ?? ANILIST_BASE_BUDGET_PER_MIN)
	);
	const throttleFactor = clampAniListThrottleFactor(
		overrides?.throttleFactor ?? budgetRow?.throttleFactor ?? 1
	);
	const effectiveCapacity = Math.max(1, Math.floor(baseCapacity * throttleFactor));
	const effectiveRefill = Math.max(1, Math.floor(baseRefill * throttleFactor));
	const lastRefillAt = budgetRow?.lastRefillAt ?? now;
	const elapsedMs = Math.max(0, now - lastRefillAt);
	const refilledTokens = Math.min(
		effectiveCapacity,
		(budgetRow?.tokens ?? effectiveCapacity) + (elapsedMs / 60_000) * effectiveRefill
	);
	return {
		baseCapacity,
		baseRefill,
		throttleFactor,
		effectiveCapacity,
		effectiveRefill,
		refilledTokens
	};
}
