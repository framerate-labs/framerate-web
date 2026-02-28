import type { Doc } from '../../_generated/dataModel';
import type { DatabaseReader } from '../../_generated/server';
import type {
	EpisodeCacheRequest,
	SeasonSourceInput,
	TMDBSeasonEpisodeRow,
	TVEpisodeRefreshSignals
} from '../../types/animeEpisodeTypes';

import { daysSinceDate, daysToMs, daysUntilDate, parseDateMs } from './dateUtils';

function msHours(hours: number): number {
	return hours * 60 * 60_000;
}

export function episodeCacheKey(tmdbId: number, seasonNumber: number): string {
	return `${tmdbId}:${seasonNumber}`;
}

export function dedupeEpisodeCacheRequests(requests: EpisodeCacheRequest[]): EpisodeCacheRequest[] {
	return Array.from(
		new Map(
			requests.map((request) => [episodeCacheKey(request.tmdbId, request.seasonNumber), request])
		).values()
	);
}

export function parseTMDBSeasonEpisodes(raw: unknown): TMDBSeasonEpisodeRow[] {
	if (!raw || typeof raw !== 'object') return [];
	const row = raw as Record<string, unknown>;
	const episodesRaw = Array.isArray(row.episodes) ? row.episodes : [];
	return episodesRaw
		.map((episode): TMDBSeasonEpisodeRow | null => {
			if (!episode || typeof episode !== 'object') return null;
			const ep = episode as Record<string, unknown>;
			const id = typeof ep.id === 'number' ? ep.id : null;
			const name = typeof ep.name === 'string' ? ep.name : null;
			const episodeNumber = typeof ep.episode_number === 'number' ? ep.episode_number : null;
			const seasonNumber = typeof ep.season_number === 'number' ? ep.season_number : null;
			if (id == null || name == null || episodeNumber == null || seasonNumber == null) return null;
			return {
				id,
				name,
				overview: typeof ep.overview === 'string' ? ep.overview : null,
				airDate: typeof ep.air_date === 'string' ? ep.air_date : null,
				runtime: typeof ep.runtime === 'number' ? ep.runtime : null,
				episodeNumber,
				seasonNumber,
				stillPath: typeof ep.still_path === 'string' ? ep.still_path : null
			};
		})
		.filter((episode): episode is TMDBSeasonEpisodeRow => episode !== null)
		.sort((a, b) => a.episodeNumber - b.episodeNumber);
}

export function sliceSeasonEpisodesForSource(
	seasonEpisodes: TMDBSeasonEpisodeRow[],
	source: Pick<SeasonSourceInput, 'tmdbEpisodeStart' | 'tmdbEpisodeEnd'>
): TMDBSeasonEpisodeRow[] {
	const start = source.tmdbEpisodeStart ?? null;
	const end = source.tmdbEpisodeEnd ?? null;
	if (start == null) return seasonEpisodes;

	const byEpisodeNumber = seasonEpisodes.filter((episode) => {
		if (end == null) return episode.episodeNumber >= start;
		return episode.episodeNumber >= start && episode.episodeNumber <= end;
	});
	if (byEpisodeNumber.length > 0) return byEpisodeNumber;

	const zeroBasedStart = Math.max(0, start - 1);
	if (zeroBasedStart >= seasonEpisodes.length) return [];
	if (end == null) return seasonEpisodes.slice(zeroBasedStart);
	const zeroBasedEndExclusive = Math.min(seasonEpisodes.length, Math.max(zeroBasedStart, end));
	return seasonEpisodes.slice(zeroBasedStart, zeroBasedEndExclusive);
}

export function normalizeSeasonSourcesForEpisodes(
	sources: SeasonSourceInput[]
): SeasonSourceInput[] {
	// Canonical ordering for deterministic rendering and cache access.
	// sequence controls in-row source placement (lower renders first).
	return sources
		.filter((source) => source.tmdbType === 'tv')
		.sort((a, b) => {
			if (a.sequence !== b.sequence) return a.sequence - b.sequence;
			const as = a.tmdbSeasonNumber ?? Number.MAX_SAFE_INTEGER;
			const bs = b.tmdbSeasonNumber ?? Number.MAX_SAFE_INTEGER;
			if (as !== bs) return as - bs;
			const ae = a.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
			const be = b.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
			if (ae !== be) return ae - be;
			const aEnd = a.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER;
			const bEnd = b.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER;
			if (aEnd !== bEnd) return aEnd - bEnd;
			if (a.sourceKey !== b.sourceKey) return a.sourceKey.localeCompare(b.sourceKey);
			return a.tmdbId - b.tmdbId;
		});
}

export function seasonRequestsForSeasonSources(
	sources: SeasonSourceInput[]
): EpisodeCacheRequest[] {
	return sources
		.map((source) => {
			const seasonNumber = source.tmdbSeasonNumber ?? null;
			if (seasonNumber == null) return null;
			return { tmdbId: source.tmdbId, seasonNumber };
		})
		.filter((request): request is EpisodeCacheRequest => request !== null);
}

export function seasonRequestsForContinuousNumberingRows(
	numberingRows: Array<{
		seasonRowKey?: string;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		sources: SeasonSourceInput[];
	}>,
	selectedSeasonRowKey: string
): EpisodeCacheRequest[] {
	const requests: EpisodeCacheRequest[] = [];
	for (const row of numberingRows) {
		const normalizedSources = normalizeSeasonSourcesForEpisodes(row.sources);
		requests.push(...seasonRequestsForSeasonSources(normalizedSources));
		const rowKey = row.seasonRowKey ?? '';
		if (rowKey === selectedSeasonRowKey) break;
	}
	const seen = new Set<string>();
	return requests.filter((request) => {
		const key = `${request.tmdbId}:${request.seasonNumber}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function latestAiredEpisodeDateString(
	episodes: TMDBSeasonEpisodeRow[],
	now: number
): string | null {
	let latestMs: number | null = null;
	let latestDate: string | null = null;
	for (const episode of episodes) {
		const ms = parseDateMs(episode.airDate);
		if (ms == null || ms > now) continue;
		if (latestMs == null || ms > latestMs) {
			latestMs = ms;
			latestDate = episode.airDate ?? null;
		}
	}
	return latestDate;
}

export function computeEpisodeCacheRefreshTime(args: {
	now: number;
	seasonNumber: number;
	episodes: TMDBSeasonEpisodeRow[];
	signals: TVEpisodeRefreshSignals | null;
}): number {
	const { now, seasonNumber, episodes, signals } = args;
	if (seasonNumber === 0) {
		const daysSinceSpecial = daysSinceDate(now, latestAiredEpisodeDateString(episodes, now));
		if (daysSinceSpecial != null && daysSinceSpecial <= 7) return now + daysToMs(1);
		if (daysSinceSpecial != null && daysSinceSpecial <= 14) return now + daysToMs(2);
		if (daysSinceSpecial != null && daysSinceSpecial <= 30) return now + daysToMs(14);
		if (daysSinceSpecial != null && daysSinceSpecial <= 90) return now + daysToMs(45);
		if (daysSinceSpecial != null && daysSinceSpecial <= 365) return now + daysToMs(180);
		return now + daysToMs(365);
	}

	const next = signals?.nextEpisodeToAir ?? null;
	const last = signals?.lastEpisodeToAir ?? null;
	const daysUntilNext = daysUntilDate(now, next?.airDate ?? null);
	const latestSeasonAiredDate = latestAiredEpisodeDateString(episodes, now);
	const daysSinceLatestSeasonEpisode = daysSinceDate(now, latestSeasonAiredDate);
	const daysSinceLastKnownEpisode = daysSinceDate(now, last?.airDate ?? null);
	const nextIsThisSeason = next?.seasonNumber === seasonNumber;
	const lastIsThisSeason = last?.seasonNumber === seasonNumber;
	const statusLower = (signals?.status ?? '').toLowerCase();
	const isEndedSeries =
		statusLower.includes('ended') ||
		statusLower.includes('cancelled') ||
		statusLower.includes('canceled');
	const statusSuggestsReturning =
		statusLower.includes('returning') ||
		statusLower.includes('planned') ||
		statusLower.includes('production');
	const progressedPastThisSeason =
		(next?.seasonNumber ?? Number.MIN_SAFE_INTEGER) > seasonNumber ||
		(last?.seasonNumber ?? Number.MIN_SAFE_INTEGER) > seasonNumber;
	const finalAiredSeasonNumber = last?.seasonNumber ?? null;

	if (nextIsThisSeason && daysUntilNext != null) {
		if (daysUntilNext <= 1) return now + msHours(6);
		if (daysUntilNext <= 7) return now + msHours(12);
		if (daysUntilNext <= 14) return now + daysToMs(2);
		if (daysUntilNext <= 30) return now + daysToMs(7);
		if (daysUntilNext <= 60) return now + daysToMs(30);
		if (daysUntilNext <= 120) return now + daysToMs(60);
		return now + daysToMs(120);
	}

	if (isEndedSeries) {
		if (finalAiredSeasonNumber != null && seasonNumber < finalAiredSeasonNumber) {
			if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode > 365)
				return now + daysToMs(180);
			return now + daysToMs(90);
		}
		if (finalAiredSeasonNumber != null && seasonNumber === finalAiredSeasonNumber) {
			const referenceDays = daysSinceLastKnownEpisode ?? daysSinceLatestSeasonEpisode;
			if (referenceDays != null && referenceDays <= 7) return now + daysToMs(1);
			if (referenceDays != null && referenceDays <= 30) return now + daysToMs(3);
			if (referenceDays != null && referenceDays <= 90) return now + daysToMs(14);
			return now + daysToMs(90);
		}
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode > 365)
			return now + daysToMs(180);
		return now + daysToMs(90);
	}

	if (progressedPastThisSeason) {
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode <= 90)
			return now + daysToMs(30);
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode <= 365)
			return now + daysToMs(90);
		return now + daysToMs(180);
	}

	if (!nextIsThisSeason && lastIsThisSeason && daysSinceLastKnownEpisode != null) {
		if (daysSinceLastKnownEpisode <= 3) return now + msHours(6);
		if (daysSinceLastKnownEpisode <= 14) return now + daysToMs(2);
		if (daysSinceLastKnownEpisode <= 30) return now + daysToMs(3);
		if (daysSinceLastKnownEpisode <= 60) return now + daysToMs(14);
		if (daysSinceLastKnownEpisode <= 90) return now + daysToMs(30);
		return now + (statusSuggestsReturning ? daysToMs(45) : daysToMs(90));
	}

	if (daysSinceLatestSeasonEpisode != null) {
		if (daysSinceLatestSeasonEpisode <= 90) return now + daysToMs(14);
		if (daysSinceLatestSeasonEpisode <= 365) return now + daysToMs(30);
		return now + daysToMs(90);
	}
	return now + (statusSuggestsReturning ? daysToMs(30) : daysToMs(45));
}

export function buildEpisodeBoundsBySeasonFromCacheRows(
	cacheRows: Array<Pick<Doc<'animeEpisodeCache'>, 'seasonNumber' | 'episodes'>>
): Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }> {
	const bounds = new Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }>();
	for (const row of cacheRows) {
		let minEpisodeNumber: number | null = null;
		let maxEpisodeNumber: number | null = null;
		for (const episode of row.episodes) {
			const episodeNumber = episode.episodeNumber;
			if (!Number.isFinite(episodeNumber)) continue;
			if (minEpisodeNumber == null || episodeNumber < minEpisodeNumber)
				minEpisodeNumber = episodeNumber;
			if (maxEpisodeNumber == null || episodeNumber > maxEpisodeNumber)
				maxEpisodeNumber = episodeNumber;
		}
		if (minEpisodeNumber == null || maxEpisodeNumber == null) continue;
		bounds.set(row.seasonNumber, { minEpisodeNumber, maxEpisodeNumber });
	}
	return bounds;
}

function pickPreferredCacheRow(rows: Doc<'animeEpisodeCache'>[]): Doc<'animeEpisodeCache'> | null {
	let best: Doc<'animeEpisodeCache'> | null = null;
	let bestFetchedAt = Number.NEGATIVE_INFINITY;
	let bestRefreshAt = Number.NEGATIVE_INFINITY;
	let bestCreatedAt = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const fetchedAt = row.fetchedAt ?? 0;
		const nextRefreshAt = row.nextRefreshAt ?? 0;
		const createdAt = row._creationTime ?? 0;
		if (
			best === null ||
			fetchedAt > bestFetchedAt ||
			(fetchedAt === bestFetchedAt && nextRefreshAt > bestRefreshAt) ||
			(fetchedAt === bestFetchedAt && nextRefreshAt === bestRefreshAt && createdAt > bestCreatedAt)
		) {
			best = row;
			bestFetchedAt = fetchedAt;
			bestRefreshAt = nextRefreshAt;
			bestCreatedAt = createdAt;
		}
	}
	return best;
}

export async function loadEpisodeCacheRowsByRequests(
	db: DatabaseReader,
	requests: EpisodeCacheRequest[]
): Promise<Doc<'animeEpisodeCache'>[]> {
	const deduped = dedupeEpisodeCacheRequests(requests);
	if (deduped.length === 0) return [];

	const seasonSetsByTMDB = new Map<number, Set<number>>();
	for (const request of deduped) {
		const set = seasonSetsByTMDB.get(request.tmdbId) ?? new Set<number>();
		set.add(request.seasonNumber);
		seasonSetsByTMDB.set(request.tmdbId, set);
	}

	const collected = await Promise.all(
		[...seasonSetsByTMDB.entries()].map(async ([tmdbId, seasons]) => {
			const rows = await db
				.query('animeEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', tmdbId))
				.collect();
			return rows.filter((row) => seasons.has(row.seasonNumber));
		})
	);

	const byKey = new Map<string, Doc<'animeEpisodeCache'>[]>();
	for (const rows of collected) {
		for (const row of rows) {
			const key = episodeCacheKey(row.tmdbId, row.seasonNumber);
			const list = byKey.get(key) ?? [];
			list.push(row);
			byKey.set(key, list);
		}
	}

	const resolved: Doc<'animeEpisodeCache'>[] = [];
	for (const request of deduped) {
		const key = episodeCacheKey(request.tmdbId, request.seasonNumber);
		const preferred = pickPreferredCacheRow(byKey.get(key) ?? []);
		if (preferred) resolved.push(preferred);
	}
	return resolved;
}
