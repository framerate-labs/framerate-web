import type {
	DetailRefreshDecision,
	HeaderContributorInput,
	StoredEpisodeSummary
} from '../../types/detailsType';
import type { NormalizedMediaDetails } from '../../types/tmdb/detailsTypes';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function parseDate(dateString: string | null | undefined): Date | null {
	if (!dateString) return null;
	const parsed = new Date(dateString);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stableJitterMs(seed: number, windowMs: number): number {
	const s = Math.max(1, Math.floor(Math.abs(seed)));
	const hash = (s * 1103515245 + 12345) & 0x7fffffff;
	return windowMs <= 0 ? 0 : hash % windowMs;
}

function withPositiveJitter(now: number, ttlMs: number, seed: number): number {
	const boundedTtl = Math.max(MINUTE_MS, ttlMs);
	const jitterWindow = Math.min(12 * HOUR_MS, Math.floor(boundedTtl * 0.1));
	return now + boundedTtl + stableJitterMs(seed, jitterWindow);
}

function normalizeStatus(status: string | undefined): string {
	return (status ?? '').trim().toLowerCase();
}

function isEndedSeries(status: string | undefined): boolean {
	const normalized = normalizeStatus(status);
	return normalized === 'ended' || normalized === 'canceled' || normalized === 'cancelled';
}

function evaluateStoredDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
	},
	now: number,
	hasTypeSpecificMissing: boolean,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hardMissing =
		(stored.detailSchemaVersion ?? 0) < detailSchemaVersion ||
		stored.detailFetchedAt === null ||
		stored.detailFetchedAt === undefined ||
		stored.overview === undefined ||
		stored.status === null ||
		stored.status === undefined ||
		hasTypeSpecificMissing;

	if (hardMissing) {
		return { needsRefresh: true, hardStale: true, reason: 'hard-stale' };
	}

	if ((stored.nextRefreshAt ?? 0) <= now) {
		return { needsRefresh: true, hardStale: false, reason: 'soft-stale' };
	}

	return { needsRefresh: false, hardStale: false, reason: 'fresh' };
}

export function computeNextRefreshAt(details: NormalizedMediaDetails, now: number): number {
	const seed = details.id;
	if (details.mediaType === 'movie') {
		const releaseDate = parseDate(details.releaseDate);
		if (releaseDate === null) {
			return withPositiveJitter(now, WEEK_MS, seed);
		}

		const releaseTime = releaseDate.getTime();
		const inThirtyDays = now + 30 * DAY_MS;
		const thirtyDaysAgo = now - 30 * DAY_MS;
		const inSevenDays = now + 7 * DAY_MS;
		const threeDaysAgo = now - 3 * DAY_MS;

		if (
			(releaseTime >= now && releaseTime <= inSevenDays) ||
			(releaseTime < now && releaseTime >= threeDaysAgo)
		) {
			return withPositiveJitter(now, 12 * HOUR_MS, seed);
		}
		if (releaseTime > inThirtyDays) {
			return withPositiveJitter(now, WEEK_MS, seed);
		}
		if (releaseTime >= thirtyDaysAgo) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}

	const normalizedStatus = normalizeStatus(details.status);
	const statusSuggestsReturning =
		normalizedStatus.includes('returning') ||
		normalizedStatus.includes('planned') ||
		normalizedStatus.includes('production');
	const nextAiring = parseDate(details.nextEpisodeToAir?.airDate ?? null);
	if (nextAiring !== null) {
		const delta = nextAiring.getTime() - now;
		if (delta <= 7 * DAY_MS) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		if (delta <= 30 * DAY_MS) {
			return withPositiveJitter(now, 3 * DAY_MS, seed);
		}
		if (delta <= 120 * DAY_MS) {
			return withPositiveJitter(now, 14 * DAY_MS, seed);
		}
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}

	const lastEpisodeAired = parseDate(details.lastEpisodeToAir?.airDate ?? null);
	if (lastEpisodeAired !== null) {
		const sinceLastEpisode = now - lastEpisodeAired.getTime();
		if (sinceLastEpisode <= 3 * DAY_MS) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		if (sinceLastEpisode <= 30 * DAY_MS) {
			return withPositiveJitter(now, 3 * DAY_MS, seed);
		}
		if (sinceLastEpisode <= 90 * DAY_MS) {
			return withPositiveJitter(now, 14 * DAY_MS, seed);
		}
		if (details.inProduction || statusSuggestsReturning) {
			if (sinceLastEpisode <= 180 * DAY_MS) {
				return withPositiveJitter(now, 30 * DAY_MS, seed);
			}
			return withPositiveJitter(now, 45 * DAY_MS, seed);
		}
	}

	const lastAir = parseDate(details.lastAirDate);
	if (isEndedSeries(details.status) && lastAir !== null) {
		const sinceLastAir = now - lastAir.getTime();
		if (sinceLastAir <= 60 * DAY_MS) {
			return withPositiveJitter(now, 30 * DAY_MS, seed);
		}
		if (sinceLastAir <= 365 * DAY_MS) {
			return withPositiveJitter(now, 90 * DAY_MS, seed);
		}
		return withPositiveJitter(now, 180 * DAY_MS, seed);
	}

	if (isEndedSeries(details.status)) {
		return withPositiveJitter(now, 90 * DAY_MS, seed);
	}

	if (details.inProduction || statusSuggestsReturning) {
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}
	return withPositiveJitter(now, 45 * DAY_MS, seed);
}

export function toStoredEpisodeSummary(
	episode: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null
): StoredEpisodeSummary | null {
	if (!episode) return null;
	if (episode.seasonNumber <= 0 || episode.episodeNumber <= 0) return null;
	return {
		airDate: episode.airDate,
		seasonNumber: episode.seasonNumber,
		episodeNumber: episode.episodeNumber
	};
}

export function evaluateStoredMovieDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		runtime?: number | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing =
		stored.runtime === undefined || stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing, detailSchemaVersion);
}

export function evaluateStoredTVDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		numberOfSeasons?: number | null;
		seasons?: unknown[] | null;
		lastAirDate?: string | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing =
		stored.numberOfSeasons === null ||
		stored.numberOfSeasons === undefined ||
		stored.lastAirDate === undefined ||
		stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing, detailSchemaVersion);
}
