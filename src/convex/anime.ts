import type { Doc, Id } from './_generated/dataModel';
import type { AniListRequestMetrics } from './services/anilistService';
import type { AniListMediaCore, AnimeXrefRow } from './types/animeTypes';
import type { MediaType } from './types/mediaTypes';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query
} from './_generated/server';
import {
	createAniListRequestMetrics,
	fetchAniListAnimeMediaById,
	searchAniListAnimeCandidates,
	summarizeAniListRateLimitHints
} from './services/anilistService';
import { matchTMDBAnimeToAniListCandidates } from './services/animeMatchService';
import { fetchTMDBAnimeSource } from './services/animeTmdbService';
import { getFinalMovie, getFinalTV } from './utils/mediaLookup';
import { fetchTMDBJson } from './utils/tmdb';

const tmdbTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const animeSyncJobTypeValidator = v.union(v.literal('picker'), v.literal('timeline'));
const animeSeedTableValidator = v.union(v.literal('tvShows'), v.literal('movies'));
// Avoid recursive type inference issues when a module action calls internal functions from the same module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const animeInternal: any = internal;

const ANIME_PICKER_SYNC_LEASE_TTL_MS = 90_000;
const ANIME_TIMELINE_SYNC_LEASE_TTL_MS = 15 * 60_000;
const ANILIST_STATED_LIMIT_PER_MIN = 90;
const ANILIST_TARGET_BUDGET_FACTOR = 0.6;
const ANILIST_BASE_BUDGET_PER_MIN = Math.max(
	1,
	Math.floor(ANILIST_STATED_LIMIT_PER_MIN * ANILIST_TARGET_BUDGET_FACTOR)
);
const ANILIST_MIN_THROTTLE_FACTOR = 0.2;
const ANIME_SYNC_QUEUE_INTERACTIVE_PICKER_PRIORITY = 100;
const ANIME_SYNC_QUEUE_BACKGROUND_PICKER_PRIORITY = 40;
const ANIME_SYNC_QUEUE_TIMELINE_PRIORITY = 10;
const ANIME_SYNC_QUEUE_DEFAULT_PICKER_COST = 12;
const ANIME_SYNC_QUEUE_DEFAULT_TIMELINE_COST = 48;
const ANIME_SYNC_QUEUE_FAILURE_RETRY_MS = 5 * 60_000;
const ANIME_SYNC_QUEUE_PRUNE_AGE_MS = 30 * 24 * 60 * 60_000;
const ANIME_QUEUE_SEED_PAGE_SIZE = 200;
const ANIME_QUEUE_SEED_SWEEP_LEASE_TTL_MS = 10 * 60_000;
const ANIME_COST_DEBUG_LOGS = true;
const ANIME_BUDGET_REFUND_MAX_OBSERVED_COST_FACTOR = 0.7;
const ANIME_ALERT_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60_000;

type AnimeSyncQueueRow = Doc<'animeSyncQueue'>;
type AnimeApiBudgetRow = Doc<'animeApiBudget'>;
type StoredAnimeRefreshSignals = {
	found: boolean;
	isAnime: boolean | null;
	isAnimeSource: 'auto' | 'manual' | null;
	status: string | null;
	lastAirDate: string | null;
	lastEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	nextEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	releaseDate: string | null;
};
type TVEpisodeRefreshSignals = {
	tmdbId: number;
	status: string | null;
	lastAirDate: string | null;
	lastEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	nextEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
};

type AnimeQueueSeedCandidate = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
};

type AnimeAlertDraft = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
	scopeType: 'title' | 'display_row' | 'tmdb_season' | 'xref';
	scopeKey: string | null;
	code: string;
	severity: 'info' | 'warning' | 'error';
	source: 'season_report' | 'needs_review';
	summary: string;
	detailsJson: string | null;
	fingerprint: string;
};

type DisplaySeasonStatus = 'open' | 'soft_closed' | 'auto_soft_closed' | 'closed' | null;

function createAnimeSyncLeaseOwner(now = Date.now()): string {
	return `anime-sync:${now}:${Math.random().toString(36).slice(2, 10)}`;
}

function animeSyncQueueKey(
	jobType: 'picker' | 'timeline',
	tmdbType: 'movie' | 'tv',
	tmdbId: number
): string {
	return `${jobType}:${tmdbType}:${tmdbId}`;
}

function animeTitleSyncLeaseKey(
	jobType: 'picker' | 'timeline',
	tmdbType: 'movie' | 'tv',
	tmdbId: number
): string {
	return `title_sync:${jobType}:${tmdbType}:${tmdbId}`;
}

function animeSeedSweepLeaseKey(table: 'tvShows' | 'movies'): string {
	return `seed_sweep:${table}`;
}

function animeSyncJobDefaultCost(jobType: 'picker' | 'timeline'): number {
	return jobType === 'picker'
		? ANIME_SYNC_QUEUE_DEFAULT_PICKER_COST
		: ANIME_SYNC_QUEUE_DEFAULT_TIMELINE_COST;
}

function clampAniListThrottleFactor(value: number): number {
	return Math.max(ANILIST_MIN_THROTTLE_FACTOR, Math.min(1, value));
}

function parseDateMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function daysUntilDate(now: number, value: string | null | undefined): number | null {
	const ms = parseDateMs(value);
	if (ms == null) return null;
	return Math.ceil((ms - now) / 86_400_000);
}

function daysSinceDate(now: number, value: string | null | undefined): number | null {
	const ms = parseDateMs(value);
	if (ms == null) return null;
	return Math.floor((now - ms) / 86_400_000);
}

function msDays(days: number): number {
	return days * 24 * 60 * 60_000;
}

function msHours(hours: number): number {
	return hours * 60 * 60_000;
}

function summarizeAniListRunMetrics(aniListMetrics: AniListRequestMetrics) {
	return {
		aniListRequestAttempts: aniListMetrics.requestAttempts,
		aniListRateLimitedResponses: aniListMetrics.rateLimitedResponses,
		aniListRateLimitHints: summarizeAniListRateLimitHints(aniListMetrics) ?? undefined
	};
}

function computePickerRefreshTtlMs(now: number, signals: StoredAnimeRefreshSignals): number {
	const daysUntilNext = daysUntilDate(now, signals.nextEpisodeToAir?.airDate ?? null);
	const daysSinceLastEpisode = daysSinceDate(now, signals.lastEpisodeToAir?.airDate ?? null);
	const daysSinceLastAir = daysSinceDate(now, signals.lastAirDate);
	const status = (signals.status ?? '').toLowerCase();
	const isEnded =
		status.includes('ended') || status.includes('canceled') || status.includes('cancelled');

	if (daysUntilNext != null) {
		if (daysUntilNext <= 14) return msDays(7);
		if (daysUntilNext <= 30) return msDays(14);
		if (daysUntilNext <= 60) return msDays(30);
		if (daysUntilNext <= 120) return msDays(60);
		return msDays(120);
	}
	if (daysSinceLastEpisode != null) {
		if (daysSinceLastEpisode <= 30) return msDays(30);
		if (daysSinceLastEpisode <= 90) return msDays(60);
	}
	if (isEnded && daysSinceLastAir != null) {
		if (daysSinceLastAir <= 60) return msDays(30);
		if (daysSinceLastAir <= 365) return msDays(180);
		return msDays(365);
	}
	return msDays(60);
}

function computeTimelineRefreshTtlMs(now: number, signals: StoredAnimeRefreshSignals): number {
	const daysUntilNext = daysUntilDate(now, signals.nextEpisodeToAir?.airDate ?? null);
	const daysSinceLastEpisode = daysSinceDate(now, signals.lastEpisodeToAir?.airDate ?? null);
	const daysSinceLastAir = daysSinceDate(now, signals.lastAirDate);
	const status = (signals.status ?? '').toLowerCase();
	const isEnded =
		status.includes('ended') || status.includes('canceled') || status.includes('cancelled');

	if (daysUntilNext != null) {
		if (daysUntilNext <= 7) return msDays(7);
		if (daysUntilNext <= 30) return msDays(30);
		if (daysUntilNext <= 120) return msDays(90);
		return msDays(180);
	}
	if (daysSinceLastEpisode != null && daysSinceLastEpisode <= 30) return msDays(60);
	if (isEnded && daysSinceLastAir != null) {
		if (daysSinceLastAir <= 365) return msDays(180);
		return msDays(365);
	}
	return msDays(180);
}

function computeAnimeQueueRefreshTtlMs(
	now: number,
	jobType: 'picker' | 'timeline',
	signals: StoredAnimeRefreshSignals
): number {
	return jobType === 'picker'
		? computePickerRefreshTtlMs(now, signals)
		: computeTimelineRefreshTtlMs(now, signals);
}

const anilistTitleValidator = v.object({
	romaji: v.union(v.string(), v.null()),
	english: v.union(v.string(), v.null()),
	native: v.union(v.string(), v.null())
});

const anilistDateValidator = v.object({
	year: v.union(v.number(), v.null()),
	month: v.union(v.number(), v.null()),
	day: v.union(v.number(), v.null())
});

const anilistStudioValidator = v.object({
	anilistStudioId: v.number(),
	name: v.string(),
	isAnimationStudio: v.optional(v.boolean()),
	isMain: v.optional(v.boolean())
});

const anilistWatchLinkValidator = v.object({
	title: v.optional(v.union(v.string(), v.null())),
	thumbnail: v.optional(v.union(v.string(), v.null())),
	url: v.string(),
	site: v.string()
});

const animeXrefCandidateValidator = v.object({
	anilistId: v.number(),
	score: v.number(),
	why: v.optional(v.string())
});

const pickerSeasonSourceValidator = v.object({
	tmdbType: v.string(),
	tmdbId: v.number(),
	tmdbSeasonNumber: v.optional(v.union(v.number(), v.null())),
	tmdbSeasonName: v.optional(v.union(v.string(), v.null())),
	tmdbEpisodeStart: v.optional(v.union(v.number(), v.null())),
	tmdbEpisodeEnd: v.optional(v.union(v.number(), v.null())),
	displayAsRegularEpisode: v.optional(v.boolean()),
	seasonOrdinal: v.optional(v.union(v.number(), v.null())),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	),
	confidence: v.number(),
	method: v.string(),
	locked: v.optional(v.boolean())
});

const pickerNumberingRowValidator = v.object({
	pickerRowKey: v.string(),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	),
	sources: v.array(pickerSeasonSourceValidator)
});

type TMDBSeasonEpisodeRow = {
	id: number;
	name: string;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	episodeNumber: number;
	seasonNumber: number;
	stillPath: string | null;
};

type EpisodeCacheRow = Doc<'animeEpisodeCache'>;
type PickerEpisodesCacheStatus = 'empty' | 'partial' | 'stale' | 'fresh';

type AnimeTitleOverrideRow = Doc<'animeTitleOverrides'>;
type AnimeDisplaySeasonRow = Doc<'animeDisplaySeasons'>;

function resolveDefaultEpisodeNumberingMode(
	titleOverride?: AnimeTitleOverrideRow | null
): 'restarting' | 'continuous' {
	return titleOverride?.defaultEpisodeNumberingMode === 'continuous' ? 'continuous' : 'restarting';
}

function resolveDisplayPlanMode(titleOverride?: AnimeTitleOverrideRow | null): 'auto' | 'custom' {
	return titleOverride?.displayPlanMode === 'custom' ? 'custom' : 'auto';
}

function isSoftClosedLikeStatus(status: DisplaySeasonStatus | undefined): boolean {
	return status === 'soft_closed' || status === 'auto_soft_closed';
}

function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function syntheticPickerRowStableSeasonId(
	tmdbType: 'movie' | 'tv',
	tmdbId: number,
	rowKey: string
): number {
	const hashed = fnv1a32(`${tmdbType}:${tmdbId}:${rowKey}`);
	const value = 1 + (hashed % 2_000_000_000);
	return -value;
}

function buildAutoDisplaySeasonRowsFromTMDBSource(
	source: Awaited<ReturnType<typeof fetchTMDBAnimeSource>>,
	episodeBoundsBySeason?: Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }>
): Array<{
	rowKey: string;
	label: string;
	sortOrder: number;
	rowType: 'main' | 'specials';
	seasonOrdinal: number | null;
	episodeNumberingMode: null;
	status: DisplaySeasonStatus;
	hidden?: boolean;
	sources: Array<{
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
		displayAsRegularEpisode?: boolean;
	}>;
}> {
	if (source.tmdbType !== 'tv') {
		return [];
	}

	const nonSpecials = source.seasons
		.filter((s) => s.seasonNumber > 0)
		.sort((a, b) => a.seasonNumber - b.seasonNumber);
	const latestSeasonNumber =
		nonSpecials.length > 0 ? nonSpecials[nonSpecials.length - 1]!.seasonNumber : null;
	const now = Date.now();
	const statusLower = (source.details.status ?? '').toLowerCase();
	const isEnded =
		statusLower.includes('ended') ||
		statusLower.includes('cancelled') ||
		statusLower.includes('canceled');
	const nextSeasonNumber =
		source.details.mediaType === 'tv'
			? (source.details.nextEpisodeToAir?.seasonNumber ?? null)
			: null;
	const lastSeasonNumber =
		source.details.mediaType === 'tv'
			? (source.details.lastEpisodeToAir?.seasonNumber ?? null)
			: null;
	const daysSinceLastEpisode =
		source.details.mediaType === 'tv'
			? daysSinceDate(now, source.details.lastEpisodeToAir?.airDate ?? null)
			: null;
	const isActivelyInProduction =
		source.details.mediaType === 'tv' ? source.details.inProduction === true : false;
	const statusSuggestsReturning =
		statusLower.includes('returning') ||
		statusLower.includes('planned') ||
		statusLower.includes('production');

	const rows: Array<{
		rowKey: string;
		label: string;
		sortOrder: number;
		rowType: 'main' | 'specials';
		seasonOrdinal: number | null;
		episodeNumberingMode: null;
		status: DisplaySeasonStatus;
		hidden?: boolean;
		sources: Array<{
			tmdbSeasonNumber: number;
			tmdbEpisodeStart: number | null;
			tmdbEpisodeEnd: number | null;
			displayAsRegularEpisode?: boolean;
		}>;
	}> = [];

	for (const season of nonSpecials) {
		let autoStatus: DisplaySeasonStatus = null;
		const episodeBounds = episodeBoundsBySeason?.get(season.seasonNumber) ?? null;
		const canBoundSeason = episodeBounds != null;
		if (latestSeasonNumber != null) {
			if (season.seasonNumber < latestSeasonNumber) {
				autoStatus = canBoundSeason ? 'closed' : null;
			} else if (season.seasonNumber === latestSeasonNumber) {
				if (isEnded) {
					autoStatus = canBoundSeason ? 'closed' : null;
				} else {
					const strongOpenSignal =
						nextSeasonNumber === latestSeasonNumber ||
						(lastSeasonNumber === latestSeasonNumber &&
							(daysSinceLastEpisode == null || daysSinceLastEpisode <= 120)) ||
						isActivelyInProduction ||
						statusSuggestsReturning;
					autoStatus = strongOpenSignal ? 'open' : null;
				}
			}
		}
		rows.push({
			rowKey: `tmdb:s${season.seasonNumber}`,
			label: season.name?.trim() || `Season ${season.seasonNumber}`,
			sortOrder: season.seasonNumber,
			rowType: 'main',
			seasonOrdinal: season.seasonNumber,
			episodeNumberingMode: null,
			// Auto lifecycle hints:
			// - older main rows are closed
			// - latest main row is open when strong TMDB airing/production signals exist
			// - null when signals are ambiguous to avoid incorrect open/closed assignment
			status: autoStatus,
			sources: [
				{
					tmdbSeasonNumber: season.seasonNumber,
					tmdbEpisodeStart:
						autoStatus === 'closed' && canBoundSeason ? episodeBounds!.minEpisodeNumber : null,
					tmdbEpisodeEnd:
						autoStatus === 'closed' && canBoundSeason ? episodeBounds!.maxEpisodeNumber : null
				}
			]
		});
	}
	if ((source.specialEpisodes?.length ?? 0) > 0) {
		rows.push({
			rowKey: 'tmdb:s0',
			label: 'Specials',
			sortOrder: 10_000,
			rowType: 'specials',
			seasonOrdinal: null,
			episodeNumberingMode: null,
			status: null,
			sources: [
				{
					tmdbSeasonNumber: 0,
					tmdbEpisodeStart: null,
					tmdbEpisodeEnd: null,
					displayAsRegularEpisode: false
				}
			]
		});
	}
	return rows;
}

function buildEpisodeBoundsBySeasonFromCacheRows(
	cacheRows: EpisodeCacheRow[]
): Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }> {
	const bounds = new Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }>();
	for (const row of cacheRows) {
		let minEpisodeNumber: number | null = null;
		let maxEpisodeNumber: number | null = null;
		for (const episode of row.episodes) {
			const episodeNumber = episode.episodeNumber;
			if (!Number.isFinite(episodeNumber)) continue;
			if (minEpisodeNumber == null || episodeNumber < minEpisodeNumber) minEpisodeNumber = episodeNumber;
			if (maxEpisodeNumber == null || episodeNumber > maxEpisodeNumber) maxEpisodeNumber = episodeNumber;
		}
		if (minEpisodeNumber == null || maxEpisodeNumber == null) continue;
		bounds.set(row.seasonNumber, { minEpisodeNumber, maxEpisodeNumber });
	}
	return bounds;
}

function normalizeDisplaySeasonSources(sources: AnimeDisplaySeasonRow['sources']): Array<{
	tmdbSeasonNumber: number;
	tmdbEpisodeStart: number | null;
	tmdbEpisodeEnd: number | null;
	displayAsRegularEpisode: boolean;
}> {
	return [...sources]
		.map((source) => ({
			tmdbSeasonNumber: source.tmdbSeasonNumber,
			tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
			tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
			displayAsRegularEpisode: source.displayAsRegularEpisode === true
		}))
		.sort((a, b) => {
			if (a.tmdbSeasonNumber !== b.tmdbSeasonNumber) return a.tmdbSeasonNumber - b.tmdbSeasonNumber;
			const aStart = a.tmdbEpisodeStart ?? Number.MIN_SAFE_INTEGER;
			const bStart = b.tmdbEpisodeStart ?? Number.MIN_SAFE_INTEGER;
			if (aStart !== bStart) return aStart - bStart;
			const aEnd = a.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER;
			const bEnd = b.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER;
			return aEnd - bEnd;
		});
}

function validateDisplaySeasonPlanRows(
	rows: Array<{
		rowKey: string;
		rowType: 'main' | 'specials' | 'custom';
		seasonOrdinal?: number | null;
		status?: DisplaySeasonStatus;
		sources: Array<{
			tmdbSeasonNumber: number;
			tmdbEpisodeStart: number | null;
			tmdbEpisodeEnd: number | null;
			displayAsRegularEpisode?: boolean;
		}>;
	}>
): void {
	const openRows = rows.filter((row) => (row.status ?? null) === 'open');
	if (openRows.length > 1) {
		throw new Error(
			`Invalid display-season plan: multiple open rows (${openRows.map((r) => r.rowKey).join(', ')})`
		);
	}
	const mainOrdinalToRowKey = new Map<number, string>();
	for (const row of rows) {
		if (row.rowType !== 'main') continue;
		const seasonOrdinal = row.seasonOrdinal ?? null;
		if (seasonOrdinal == null || !Number.isFinite(seasonOrdinal)) continue;
		const existing = mainOrdinalToRowKey.get(seasonOrdinal);
		if (existing) {
			throw new Error(
				`Invalid display-season plan: duplicate seasonOrdinal ${seasonOrdinal} on main rows (${existing} and ${row.rowKey})`
			);
		}
		mainOrdinalToRowKey.set(seasonOrdinal, row.rowKey);
	}

	const rangesBySeason = new Map<number, Array<{ rowKey: string; start: number; end: number }>>();
	for (const row of rows) {
		if (!row.rowKey.trim()) throw new Error('Invalid display-season plan: rowKey cannot be empty');
		const status = row.status ?? null;
		for (const source of row.sources) {
			const start = source.tmdbEpisodeStart ?? 1;
			const end = source.tmdbEpisodeEnd ?? null;
			if (end != null && end < start) {
				throw new Error(
					`Invalid display-season plan: ${row.rowKey} has source range end < start for TMDB season ${source.tmdbSeasonNumber}`
				);
			}
			if ((status === 'closed' || isSoftClosedLikeStatus(status)) && end == null) {
				throw new Error(
					`Invalid display-season plan: non-open row ${row.rowKey} must use explicit tmdbEpisodeEnd values`
				);
			}
			const normalizedEnd = end ?? Number.POSITIVE_INFINITY;
			const list = rangesBySeason.get(source.tmdbSeasonNumber) ?? [];
			for (const existing of list) {
				const overlaps = start <= existing.end && existing.start <= normalizedEnd;
				if (overlaps) {
					throw new Error(
						`Invalid display-season plan: overlapping source ranges in TMDB season ${source.tmdbSeasonNumber} (${existing.rowKey} and ${row.rowKey})`
					);
				}
			}
			list.push({ rowKey: row.rowKey, start, end: normalizedEnd });
			rangesBySeason.set(source.tmdbSeasonNumber, list);
		}
	}
}

function normalizeDisplaySeasonRowsForWrite<
	T extends {
		rowKey: string;
		label: string;
		sortOrder: number;
		rowType: 'main' | 'specials' | 'custom';
		seasonOrdinal?: number | null;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		status?: DisplaySeasonStatus;
		hidden?: boolean;
		locked?: boolean;
		sources: Array<{
			tmdbSeasonNumber: number;
			tmdbEpisodeStart: number | null;
			tmdbEpisodeEnd: number | null;
			displayAsRegularEpisode?: boolean;
		}>;
	}
>(rows: T[]): Array<T & { seasonOrdinal: number | null; sortOrder: number }> {
	return rows.map((row) => {
		const seasonOrdinal = row.seasonOrdinal ?? null;
		const normalizedSortOrder =
			row.rowType === 'specials'
				? 10_000
				: row.rowType === 'main' && seasonOrdinal != null && Number.isFinite(seasonOrdinal)
					? seasonOrdinal
					: row.sortOrder;
		return {
			...row,
			seasonOrdinal,
			sortOrder: normalizedSortOrder
		};
	});
}

function computePlanUpdatedAt(rows: Array<{ updatedAt?: number }>): number {
	let max = 0;
	for (const row of rows) {
		const updatedAt = row.updatedAt ?? 0;
		if (updatedAt > max) max = updatedAt;
	}
	return max;
}

function animeAlertFingerprint(parts: Array<string | number | null | undefined>): string {
	return parts.map((part) => (part == null ? 'none' : String(part))).join(':');
}

type EpisodePoint = { tmdbSeasonNumber: number; tmdbEpisodeNumber: number };

function compareEpisodePoint(a: EpisodePoint, b: EpisodePoint): number {
	if (a.tmdbSeasonNumber !== b.tmdbSeasonNumber) return a.tmdbSeasonNumber - b.tmdbSeasonNumber;
	return a.tmdbEpisodeNumber - b.tmdbEpisodeNumber;
}

function sourceCoversEpisodePoint(
	source: {
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
	},
	point: EpisodePoint
): boolean {
	if (source.tmdbSeasonNumber !== point.tmdbSeasonNumber) return false;
	const start = source.tmdbEpisodeStart ?? 1;
	const end = source.tmdbEpisodeEnd ?? Number.POSITIVE_INFINITY;
	return point.tmdbEpisodeNumber >= start && point.tmdbEpisodeNumber <= end;
}

function anySourceCoversEpisodePoint(
	sources: Array<{
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
	}>,
	point: EpisodePoint
): boolean {
	for (const source of sources) {
		if (sourceCoversEpisodePoint(source, point)) return true;
	}
	return false;
}

function episodePointFromTVEpisode(
	episode: { seasonNumber?: number | null; episodeNumber?: number | null } | null | undefined
): EpisodePoint | null {
	const tmdbSeasonNumber = episode?.seasonNumber ?? null;
	const tmdbEpisodeNumber = episode?.episodeNumber ?? null;
	if (
		tmdbSeasonNumber == null ||
		tmdbEpisodeNumber == null ||
		!Number.isFinite(tmdbSeasonNumber) ||
		!Number.isFinite(tmdbEpisodeNumber)
	) {
		return null;
	}
	return { tmdbSeasonNumber, tmdbEpisodeNumber };
}

function estimateDisplaySeasonEpisodeCount(
	row: Pick<AnimeDisplaySeasonRow, 'sources'>
): number | null {
	let total = 0;
	for (const source of row.sources) {
		if (source.tmdbSeasonNumber === 0 && source.displayAsRegularEpisode !== true) continue;
		const start = source.tmdbEpisodeStart ?? null;
		const end = source.tmdbEpisodeEnd ?? null;
		if (start == null || end == null || end < start) return null;
		total += end - start + 1;
	}
	return total > 0 ? total : null;
}

function isSpecialOnlyPickerRow(row: {
	pickerSeasonSources?: Array<{ tmdbSeasonNumber?: number | null }> | null;
	seasonXref?: { tmdbSeasonNumber?: number | null } | null;
}): boolean {
	const sources = row.pickerSeasonSources ?? [];
	if (sources.length > 0) {
		return sources.every((source) => (source.tmdbSeasonNumber ?? null) === 0);
	}
	return (row.seasonXref?.tmdbSeasonNumber ?? null) === 0;
}

function computeDisplaySeasonCountFromPickerRows(
	rows: Array<{
		stableSeasonId: number;
		pickerMemberAnilistIds?: number[] | null;
		pickerSeasonSources?: Array<{ tmdbSeasonNumber?: number | null }> | null;
		seasonXref?: { tmdbSeasonNumber?: number | null } | null;
	}>,
	mode: 'anilist' | 'tmdb_seasons' = 'anilist'
): number | null {
	if (mode === 'tmdb_seasons') {
		let count = 0;
		for (const row of rows) {
			if (isSpecialOnlyPickerRow(row)) continue;
			count += 1;
		}
		return count > 0 ? count : null;
	}
	const seasonKeys = new Set<string>();
	for (const row of rows) {
		if (isSpecialOnlyPickerRow(row)) continue;
		const memberIds = (row.pickerMemberAnilistIds ?? []).slice().sort((a, b) => a - b);
		if (memberIds.length > 0) {
			seasonKeys.add(`members:${memberIds.join(',')}`);
			continue;
		}
		seasonKeys.add(`stable:${row.stableSeasonId}`);
	}
	return seasonKeys.size > 0 ? seasonKeys.size : null;
}

function estimatePickerRowEpisodeCount(row: {
	media?: { episodes?: number | null } | null;
	pickerSeasonSources?: Array<{
		tmdbSeasonNumber?: number | null;
		tmdbEpisodeStart?: number | null;
		tmdbEpisodeEnd?: number | null;
	}> | null;
}): number | null {
	const sources = row.pickerSeasonSources ?? [];
	const nonSpecialSources = sources.filter((s) => (s.tmdbSeasonNumber ?? null) !== 0);
	if (nonSpecialSources.length > 0) {
		let total = 0;
		let allBounded = true;
		for (const source of nonSpecialSources) {
			const start = source.tmdbEpisodeStart ?? null;
			const end = source.tmdbEpisodeEnd ?? null;
			if (start == null || end == null || end < start) {
				allBounded = false;
				break;
			}
			total += end - start + 1;
		}
		if (allBounded) return total;
	}
	const mediaEpisodes = row.media?.episodes ?? null;
	return mediaEpisodes != null && mediaEpisodes > 0 ? mediaEpisodes : null;
}

function applyEpisodeDisplayStartsToPickerRows<
	T extends {
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		media?: { episodes?: number | null } | null;
		pickerSeasonSources?: Array<{
			tmdbSeasonNumber?: number | null;
			tmdbEpisodeStart?: number | null;
			tmdbEpisodeEnd?: number | null;
		}> | null;
	}
>(rows: T[]): Array<T & { episodeDisplayStart: number | null }> {
	let continuousCounter = 1;
	let canResolveContinuousCounter = true;
	return rows.map((row) => {
		const isSpecialOnly = isSpecialOnlyPickerRow(row);
		const mode = row.episodeNumberingMode ?? 'restarting';
		let episodeDisplayStart: number | null = null;
		if (!isSpecialOnly) {
			if (mode === 'continuous') {
				episodeDisplayStart = canResolveContinuousCounter ? continuousCounter : null;
			} else {
				episodeDisplayStart = 1;
			}
		}
		const estimatedCount = estimatePickerRowEpisodeCount(row);
		if (!isSpecialOnly && mode === 'continuous') {
			if (estimatedCount != null && estimatedCount > 0 && canResolveContinuousCounter) {
				continuousCounter += estimatedCount;
			} else if (estimatedCount == null) {
				canResolveContinuousCounter = false;
			}
		}
		return { ...row, episodeDisplayStart };
	});
}

function dedupeById<T extends { id: number }>(rows: T[]): T[] {
	const seen = new Set<number>();
	const result: T[] = [];
	for (const row of rows) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		result.push(row);
	}
	return result;
}

function toCachePayload(media: AniListMediaCore) {
	return {
		anilistId: media.id,
		title: {
			romaji: media.title.romaji ?? null,
			english: media.title.english ?? null,
			native: media.title.native ?? null
		},
		format: media.format ?? undefined,
		startDate: media.startDate
			? {
					year: media.startDate.year ?? null,
					month: media.startDate.month ?? null,
					day: media.startDate.day ?? null
				}
			: undefined,
		seasonYear: media.seasonYear ?? undefined,
		episodes: media.episodes ?? undefined,
		description: media.description ?? undefined,
		studios:
			media.studios && media.studios.length > 0
				? media.studios.map((studio) => ({
						anilistStudioId: studio.anilistStudioId,
						name: studio.name,
						isAnimationStudio: studio.isAnimationStudio,
						isMain: studio.isMain
					}))
				: undefined,
		watchLinks:
			media.watchLinks && media.watchLinks.length > 0
				? media.watchLinks.map((link) => ({
						title: link.title ?? null,
						thumbnail: link.thumbnail ?? null,
						url: link.url,
						site: link.site
					}))
				: undefined
	};
}

function buildSearchTerms(title: string, originalTitle: string): string[] {
	const terms = [originalTitle, title]
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(terms)];
}

function parseTMDBSeasonEpisodes(raw: unknown): TMDBSeasonEpisodeRow[] {
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

type PickerSeasonSourceInput = {
	tmdbType: string;
	tmdbId: number;
	tmdbSeasonNumber?: number | null;
	tmdbEpisodeStart?: number | null;
	tmdbEpisodeEnd?: number | null;
	displayAsRegularEpisode?: boolean;
	seasonOrdinal?: number | null;
	episodeNumberingMode?: 'restarting' | 'continuous' | null;
	confidence: number;
	method: string;
	locked?: boolean;
};

async function fetchEpisodesForPickerSources(
	sources: PickerSeasonSourceInput[],
	preloadedSeasonCache?: Map<string, TMDBSeasonEpisodeRow[]>,
	options?: {
		allowNetworkFetch?: boolean;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		episodeDisplayStart?: number | null;
	}
) {
	const seasonFetchCache = new Map<string, TMDBSeasonEpisodeRow[]>(preloadedSeasonCache ?? []);
	const allowNetworkFetch = options?.allowNetworkFetch ?? true;
	const requestedNumberingMode = options?.episodeNumberingMode ?? 'restarting';
	const results: Array<{
		id: string;
		tmdbType: string;
		tmdbId: number;
		tmdbSeasonNumber: number;
		tmdbEpisodeNumber: number;
		displayEpisodeNumber: number | null;
		displayNumberLabel: string;
		title: string;
		overview: string | null;
		airDate: string | null;
		runtime: number | null;
		stillPath: string | null;
	}> = [];

	let specialLabelCounter = 1;
	let continuousPickerEpisodeNumber = Math.max(1, options?.episodeDisplayStart ?? 1);
	let restartingRowEpisodeNumber = 1;
	for (const source of sources) {
		if (source.tmdbType !== 'tv') continue;
		const seasonNumber = source.tmdbSeasonNumber ?? null;
		if (seasonNumber == null) continue;

		const cacheKey = `${source.tmdbId}:${seasonNumber}`;
		let seasonEpisodes = seasonFetchCache.get(cacheKey);
		if (!seasonEpisodes) {
			if (!allowNetworkFetch) continue;
			const raw = await fetchTMDBJson(`/tv/${source.tmdbId}/season/${seasonNumber}`);
			seasonEpisodes = parseTMDBSeasonEpisodes(raw);
			seasonFetchCache.set(cacheKey, seasonEpisodes);
		}

		const sliced = sliceSeasonEpisodesForPickerSource(seasonEpisodes, source);

		for (const episode of sliced) {
			const treatSpecialAsRegular = seasonNumber === 0 && source.displayAsRegularEpisode === true;
			if (seasonNumber === 0 && !treatSpecialAsRegular) {
				results.push({
					id: `tv:${source.tmdbId}:0:${episode.episodeNumber}`,
					tmdbType: 'tv',
					tmdbId: source.tmdbId,
					tmdbSeasonNumber: 0,
					tmdbEpisodeNumber: episode.episodeNumber,
					displayEpisodeNumber: null,
					displayNumberLabel: `SP${specialLabelCounter}`,
					title: episode.name,
					overview: episode.overview,
					airDate: episode.airDate,
					runtime: episode.runtime,
					stillPath: episode.stillPath
				});
				specialLabelCounter += 1;
				continue;
			}

			let displayEpisodeNumber: number;
			if (requestedNumberingMode === 'restarting') {
				displayEpisodeNumber = restartingRowEpisodeNumber;
			} else {
				displayEpisodeNumber = continuousPickerEpisodeNumber;
			}
			results.push({
				id: `tv:${source.tmdbId}:${seasonNumber}:${episode.episodeNumber}`,
				tmdbType: 'tv',
				tmdbId: source.tmdbId,
				tmdbSeasonNumber: seasonNumber,
				tmdbEpisodeNumber: episode.episodeNumber,
				displayEpisodeNumber,
				displayNumberLabel: `E${displayEpisodeNumber}`,
				title: episode.name,
				overview: episode.overview,
				airDate: episode.airDate,
				runtime: episode.runtime,
				stillPath: episode.stillPath
			});
			if (requestedNumberingMode === 'continuous') {
				continuousPickerEpisodeNumber += 1;
			}
			restartingRowEpisodeNumber += 1;
		}
	}

	return results;
}

async function countRenderedNonSpecialEpisodesForPickerSources(
	sources: PickerSeasonSourceInput[],
	seasonFetchCache: Map<string, TMDBSeasonEpisodeRow[]>,
	allowNetworkFetch: boolean
): Promise<number | null> {
	let total = 0;
	for (const source of sources) {
		if (source.tmdbType !== 'tv') continue;
		const seasonNumber = source.tmdbSeasonNumber ?? null;
		if (seasonNumber == null) continue;
		if (seasonNumber == 0 && source.displayAsRegularEpisode !== true) continue;

		const cacheKey = `${source.tmdbId}:${seasonNumber}`;
		let seasonEpisodes = seasonFetchCache.get(cacheKey);
		if (!seasonEpisodes) {
			if (!allowNetworkFetch) return null;
			const raw = await fetchTMDBJson(`/tv/${source.tmdbId}/season/${seasonNumber}`);
			seasonEpisodes = parseTMDBSeasonEpisodes(raw);
			seasonFetchCache.set(cacheKey, seasonEpisodes);
		}

		const count = sliceSeasonEpisodesForPickerSource(seasonEpisodes, source).length;
		total += count;
	}
	return total;
}

async function computeEpisodeDisplayStartFromNumberingRows(
	numberingRows: Array<{
		pickerRowKey: string;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		sources: PickerSeasonSourceInput[];
	}>,
	selectedPickerRowKey: string,
	seasonFetchCache: Map<string, TMDBSeasonEpisodeRow[]>,
	allowNetworkFetch: boolean
): Promise<number | null> {
	let totalBeforeSelected = 0;
	let foundSelected = false;
	for (const row of numberingRows) {
		const normalizedSources = normalizePickerSourcesForEpisodes(row.sources);
		if (row.pickerRowKey == selectedPickerRowKey) {
			foundSelected = true;
			break;
		}
		const count = await countRenderedNonSpecialEpisodesForPickerSources(
			normalizedSources,
			seasonFetchCache,
			allowNetworkFetch
		);
		if (count == null) return null;
		totalBeforeSelected += count;
	}
	if (!foundSelected) return null;
	return Math.max(1, totalBeforeSelected + 1);
}

function sliceSeasonEpisodesForPickerSource(
	seasonEpisodes: TMDBSeasonEpisodeRow[],
	source: Pick<PickerSeasonSourceInput, 'tmdbEpisodeStart' | 'tmdbEpisodeEnd'>
): TMDBSeasonEpisodeRow[] {
	const start = source.tmdbEpisodeStart ?? null;
	const end = source.tmdbEpisodeEnd ?? null;
	if (start == null) return seasonEpisodes;

	const byEpisodeNumber = seasonEpisodes.filter((episode) => {
		if (end == null) return episode.episodeNumber >= start;
		return episode.episodeNumber >= start && episode.episodeNumber <= end;
	});
	if (byEpisodeNumber.length > 0) return byEpisodeNumber;

	// Some TMDB season payloads use globally-continuing episode numbers. In those
	// cases, picker slice ranges (1...N) are effectively season-local indices.
	const zeroBasedStart = Math.max(0, start - 1);
	if (zeroBasedStart >= seasonEpisodes.length) return [];
	if (end == null) return seasonEpisodes.slice(zeroBasedStart);
	const zeroBasedEndExclusive = Math.min(seasonEpisodes.length, Math.max(zeroBasedStart, end));
	return seasonEpisodes.slice(zeroBasedStart, zeroBasedEndExclusive);
}

function normalizePickerSourcesForEpisodes(
	sources: PickerSeasonSourceInput[]
): PickerSeasonSourceInput[] {
	return sources
		.filter((source) => source.tmdbType === 'tv')
		.sort((a, b) => {
			const as = a.tmdbSeasonNumber ?? Number.MAX_SAFE_INTEGER;
			const bs = b.tmdbSeasonNumber ?? Number.MAX_SAFE_INTEGER;
			if (as !== bs) return as - bs;
			const ae = a.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
			const be = b.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
			if (ae !== be) return ae - be;
			return a.tmdbId - b.tmdbId;
		});
}

function seasonRequestsForPickerSources(sources: PickerSeasonSourceInput[]) {
	return sources
		.map((source) => {
			const seasonNumber = source.tmdbSeasonNumber ?? null;
			if (seasonNumber == null) return null;
			return { tmdbId: source.tmdbId, seasonNumber };
		})
		.filter((request): request is { tmdbId: number; seasonNumber: number } => request !== null);
}

function seasonRequestsForContinuousNumberingRows(
	numberingRows: Array<{
		pickerRowKey: string;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		sources: PickerSeasonSourceInput[];
	}>,
	selectedPickerRowKey: string
) {
	const requests: Array<{ tmdbId: number; seasonNumber: number }> = [];
	for (const row of numberingRows) {
		const normalizedSources = normalizePickerSourcesForEpisodes(row.sources);
		requests.push(...seasonRequestsForPickerSources(normalizedSources));
		if (row.pickerRowKey === selectedPickerRowKey) break;
	}
	const seen = new Set<string>();
	return requests.filter((request) => {
		const key = `${request.tmdbId}:${request.seasonNumber}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function episodeCacheKey(tmdbId: number, seasonNumber: number): string {
	return `${tmdbId}:${seasonNumber}`;
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

function computeEpisodeCacheRefreshTime(args: {
	now: number;
	seasonNumber: number;
	episodes: TMDBSeasonEpisodeRow[];
	signals: TVEpisodeRefreshSignals | null;
}): number {
	const { now, seasonNumber, episodes, signals } = args;
	if (seasonNumber === 0) {
		const daysSinceSpecial = daysSinceDate(now, latestAiredEpisodeDateString(episodes, now));
		if (daysSinceSpecial != null && daysSinceSpecial <= 7) return now + msDays(1);
		if (daysSinceSpecial != null && daysSinceSpecial <= 14) return now + msDays(2);
		if (daysSinceSpecial != null && daysSinceSpecial <= 30) return now + msDays(14);
		if (daysSinceSpecial != null && daysSinceSpecial <= 90) return now + msDays(45);
		if (daysSinceSpecial != null && daysSinceSpecial <= 365) return now + msDays(180);
		return now + msDays(365);
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

	// This season has an upcoming episode scheduled by TMDB.
	if (nextIsThisSeason && daysUntilNext != null) {
		if (daysUntilNext <= 1) return now + msHours(6);
		if (daysUntilNext <= 7) return now + msHours(12);
		if (daysUntilNext <= 14) return now + msDays(2);
		if (daysUntilNext <= 30) return now + msDays(7);
		if (daysUntilNext <= 60) return now + msDays(30);
		if (daysUntilNext <= 120) return now + msDays(60);
		return now + msDays(120);
	}

	if (isEndedSeries) {
		// Ended-show optimization: non-final seasons can decay quickly.
		if (finalAiredSeasonNumber != null && seasonNumber < finalAiredSeasonNumber) {
			if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode > 365)
				return now + msDays(180);
			return now + msDays(90);
		}
		// Final season gets a short post-finale correction window, then decays.
		if (finalAiredSeasonNumber != null && seasonNumber === finalAiredSeasonNumber) {
			const referenceDays = daysSinceLastKnownEpisode ?? daysSinceLatestSeasonEpisode;
			if (referenceDays != null && referenceDays <= 7) return now + msDays(1);
			if (referenceDays != null && referenceDays <= 30) return now + msDays(3);
			if (referenceDays != null && referenceDays <= 90) return now + msDays(14);
			return now + msDays(90);
		}
		// Ambiguous ended rows still decay aggressively.
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode > 365)
			return now + msDays(180);
		return now + msDays(90);
	}

	// A newer season already progressed; this season should be treated as closed.
	if (progressedPastThisSeason) {
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode <= 90)
			return now + msDays(30);
		if (daysSinceLatestSeasonEpisode != null && daysSinceLatestSeasonEpisode <= 365)
			return now + msDays(90);
		return now + msDays(180);
	}

	// Likely data lag / gap week window for the latest airing season when next episode is missing.
	if (!nextIsThisSeason && lastIsThisSeason && daysSinceLastKnownEpisode != null) {
		if (daysSinceLastKnownEpisode <= 3) return now + msHours(6);
		if (daysSinceLastKnownEpisode <= 14) return now + msDays(2);
		if (daysSinceLastKnownEpisode <= 30) return now + msDays(3);
		if (daysSinceLastKnownEpisode <= 60) return now + msDays(14);
		if (daysSinceLastKnownEpisode <= 90) return now + msDays(30);
		return now + (statusSuggestsReturning ? msDays(45) : msDays(90));
	}

	// Uncertain fallback.
	if (daysSinceLatestSeasonEpisode != null) {
		if (daysSinceLatestSeasonEpisode <= 90) return now + msDays(14);
		if (daysSinceLatestSeasonEpisode <= 365) return now + msDays(30);
		return now + msDays(90);
	}
	return now + (statusSuggestsReturning ? msDays(30) : msDays(45));
}

export const getEpisodeCachesBySeasons = internalQuery({
	args: {
		requests: v.array(
			v.object({
				tmdbId: v.number(),
				seasonNumber: v.number()
			})
		)
	},
	handler: async (ctx, args) => {
		const rows: Doc<'animeEpisodeCache'>[] = [];
			for (const request of args.requests) {
				const found = await ctx.db
					.query('animeEpisodeCache')
					.withIndex('by_tmdbId_seasonNumber', (q) =>
						q.eq('tmdbId', request.tmdbId).eq('seasonNumber', request.seasonNumber)
					)
					.collect();
			if (found[0]) rows.push(found[0]);
		}
		return rows;
	}
});

export const upsertEpisodeCaches = internalMutation({
	args: {
		rows: v.array(
			v.object({
				tmdbId: v.number(),
				seasonNumber: v.number(),
				episodes: v.array(
					v.object({
						id: v.number(),
						name: v.string(),
						overview: v.union(v.string(), v.null()),
						airDate: v.union(v.string(), v.null()),
						runtime: v.union(v.number(), v.null()),
						episodeNumber: v.number(),
						seasonNumber: v.number(),
						stillPath: v.union(v.string(), v.null())
					})
				),
				fetchedAt: v.number(),
				nextRefreshAt: v.number()
			})
		)
	},
	handler: async (ctx, args) => {
		let inserted = 0;
		let updated = 0;
		for (const row of args.rows) {
			const existing = await ctx.db
				.query('animeEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) =>
					q.eq('tmdbId', row.tmdbId).eq('seasonNumber', row.seasonNumber)
				)
				.collect();
			const [first, ...dups] = existing;
			for (const dup of dups) await ctx.db.delete(dup._id);
			if (first) {
				await ctx.db.patch(first._id, {
					episodes: row.episodes,
					fetchedAt: row.fetchedAt,
					nextRefreshAt: row.nextRefreshAt
				});
				updated += 1;
			} else {
				await ctx.db.insert('animeEpisodeCache', row);
				inserted += 1;
			}
		}
		return { inserted, updated };
	}
});

export const reconcileAutoDisplaySeasonBoundsFromEpisodeCache = internalMutation({
	args: {
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const titleOverrideRows = await ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', 'tv').eq('tmdbId', args.tmdbId))
			.collect();
		const titleOverride = titleOverrideRows[0] ?? null;
		if (resolveDisplayPlanMode(titleOverride) === 'custom') {
			return { ok: true, skippedCustom: true, updatedRows: 0 };
		}

		const [displayRows, cacheRows, tvBase] = await Promise.all([
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', 'tv').eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('animeEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique()
		]);
		const tvRow = tvBase ? await getFinalTV(ctx, tvBase) : null;
		const statusLower = (tvRow?.status ?? '').toLowerCase();
		const isEndedSeries =
			statusLower.includes('ended') ||
			statusLower.includes('cancelled') ||
			statusLower.includes('canceled');
		const boundsBySeason = buildEpisodeBoundsBySeasonFromCacheRows(cacheRows);
		const latestMainOrdinal = displayRows
			.filter((row) => row.rowType === 'main' && Number.isFinite(row.seasonOrdinal ?? null))
			.reduce<number | null>((max, row) => {
				const value = row.seasonOrdinal ?? null;
				if (value == null) return max;
				return max == null ? value : Math.max(max, value);
			}, null);
		let updatedRows = 0;
		for (const row of displayRows) {
			if (row.sourceMode !== 'auto') continue;
			if (row.rowType !== 'main') continue;

			let changed = false;
			let nextStatus = (row.status ?? null) as DisplaySeasonStatus;
			if (
				nextStatus !== 'closed' &&
				row.seasonOrdinal != null &&
				latestMainOrdinal != null &&
				(boundsBySeason.get(row.seasonOrdinal) != null ||
					row.sources.some((source) => boundsBySeason.get(source.tmdbSeasonNumber) != null))
			) {
				if (row.seasonOrdinal < latestMainOrdinal || isEndedSeries) {
					nextStatus = 'closed';
					changed = true;
				}
			}
			const nextSources = row.sources.map((source) => {
				const bounds = boundsBySeason.get(source.tmdbSeasonNumber);
				if (!bounds) return source;
				const nextStart = bounds.minEpisodeNumber;
				const nextEnd = bounds.maxEpisodeNumber;
				const currentStart = source.tmdbEpisodeStart ?? null;
				const currentEnd = source.tmdbEpisodeEnd ?? null;
				if (currentStart === nextStart && currentEnd === nextEnd) return source;
				changed = true;
				return {
					...source,
					tmdbEpisodeStart: nextStart,
					tmdbEpisodeEnd: nextEnd
				};
			});
			if (!changed) continue;
			await ctx.db.patch(row._id, {
				status: nextStatus,
				sources: nextSources,
				updatedAt: Date.now()
			});
			updatedRows += 1;
		}
		return { ok: true, skippedCustom: false, updatedRows };
	}
});

export const clearMissingEpisodeCacheAlertsForSeasons = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		seasonNumbers: v.array(v.number())
	},
	handler: async (ctx, args) => {
		if (args.seasonNumbers.length === 0) return { ok: true, deleted: 0 };
		const seasonScopeKeys = new Set(args.seasonNumbers.map((n) => `season:${n}`));
		const existing = await ctx.db
			.query('animeAlerts')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		let deleted = 0;
		for (const row of existing) {
			if (row.code !== 'missing_episode_cache') continue;
			if (!row.scopeKey || !seasonScopeKeys.has(row.scopeKey)) continue;
			await ctx.db.delete(row._id);
			deleted += 1;
		}
		return { ok: true, deleted };
	}
});

async function fetchSeasonEpisodesWithCache(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx: any,
	requests: Array<{ tmdbId: number; seasonNumber: number }>
): Promise<Map<string, TMDBSeasonEpisodeRow[]>> {
	const dedupedRequests = Array.from(
		new Map(
			requests.map(
				(request) => [episodeCacheKey(request.tmdbId, request.seasonNumber), request] as const
			)
		).values()
	);
	if (dedupedRequests.length === 0) return new Map();

	const cacheRows = (await ctx.runQuery(animeInternal.anime.getEpisodeCachesBySeasons, {
		requests: dedupedRequests
	})) as EpisodeCacheRow[];
	const cacheByKey = new Map(
		cacheRows.map((row) => [episodeCacheKey(row.tmdbId, row.seasonNumber), row] as const)
	);
	const tvSignalsRows = (await ctx.runQuery(
		animeInternal.anime.getTVEpisodeRefreshSignalsByTMDBIds,
		{
			tmdbIds: dedupedRequests.map((request) => request.tmdbId)
		}
	)) as TVEpisodeRefreshSignals[];
	const tvSignalsByTmdbId = new Map(tvSignalsRows.map((row) => [row.tmdbId, row] as const));

	const now = Date.now();
	const result = new Map<string, TMDBSeasonEpisodeRow[]>();
	const rowsToUpsert: Array<{
		tmdbId: number;
		seasonNumber: number;
		episodes: TMDBSeasonEpisodeRow[];
		fetchedAt: number;
		nextRefreshAt: number;
	}> = [];

	for (const request of dedupedRequests) {
		const key = episodeCacheKey(request.tmdbId, request.seasonNumber);
		const cached = cacheByKey.get(key);
		const isFresh = cached ? (cached.nextRefreshAt ?? 0) > now : false;
		if (cached && isFresh) {
			result.set(key, cached.episodes as TMDBSeasonEpisodeRow[]);
			continue;
		}

		if (cached && !isFresh) {
			try {
				const raw = await fetchTMDBJson(`/tv/${request.tmdbId}/season/${request.seasonNumber}`);
				const episodes = parseTMDBSeasonEpisodes(raw);
				result.set(key, episodes);
				rowsToUpsert.push({
					tmdbId: request.tmdbId,
					seasonNumber: request.seasonNumber,
					episodes,
					fetchedAt: now,
					nextRefreshAt: computeEpisodeCacheRefreshTime({
						now,
						seasonNumber: request.seasonNumber,
						episodes,
						signals: tvSignalsByTmdbId.get(request.tmdbId) ?? null
					})
				});
			} catch {
				result.set(key, cached.episodes as TMDBSeasonEpisodeRow[]);
			}
			continue;
		}

		const raw = await fetchTMDBJson(`/tv/${request.tmdbId}/season/${request.seasonNumber}`);
		const episodes = parseTMDBSeasonEpisodes(raw);
		result.set(key, episodes);
		rowsToUpsert.push({
			tmdbId: request.tmdbId,
			seasonNumber: request.seasonNumber,
			episodes,
			fetchedAt: now,
			nextRefreshAt: computeEpisodeCacheRefreshTime({
				now,
				seasonNumber: request.seasonNumber,
				episodes,
				signals: tvSignalsByTmdbId.get(request.tmdbId) ?? null
			})
		});
	}

	if (rowsToUpsert.length > 0) {
		await ctx.runMutation(animeInternal.anime.upsertEpisodeCaches, {
			rows: rowsToUpsert
		});
		const touchedSeasonsByTmdbId = new Map<number, Set<number>>();
		for (const row of rowsToUpsert) {
			const set = touchedSeasonsByTmdbId.get(row.tmdbId) ?? new Set<number>();
			set.add(row.seasonNumber);
			touchedSeasonsByTmdbId.set(row.tmdbId, set);
		}
		for (const [tmdbId, seasonSet] of touchedSeasonsByTmdbId) {
			await ctx.runMutation(animeInternal.anime.clearMissingEpisodeCacheAlertsForSeasons, {
				tmdbType: 'tv',
				tmdbId,
				seasonNumbers: [...seasonSet]
			});
		}
		const touchedTmdbIds = [...new Set(rowsToUpsert.map((row) => row.tmdbId))];
		for (const tmdbId of touchedTmdbIds) {
			await ctx.runMutation(animeInternal.anime.reconcileAutoDisplaySeasonBoundsFromEpisodeCache, {
				tmdbId
			});
		}
	}

	return result;
}

async function getEpisodeCacheRowsFromDB(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx: any,
	requests: Array<{ tmdbId: number; seasonNumber: number }>
): Promise<EpisodeCacheRow[]> {
	const dedupedRequests = Array.from(
		new Map(
			requests.map(
				(request) => [episodeCacheKey(request.tmdbId, request.seasonNumber), request] as const
			)
		).values()
	);
	const rows: EpisodeCacheRow[] = [];
	for (const request of dedupedRequests) {
		const found = await ctx.db
			.query('animeEpisodeCache')
			.withIndex('by_tmdbId_seasonNumber', (q) =>
				q.eq('tmdbId', request.tmdbId).eq('seasonNumber', request.seasonNumber)
			)
			.collect();
		if (found[0]) rows.push(found[0] as EpisodeCacheRow);
	}
	return rows;
}

function buildPickerEpisodesCachedPayload(args: {
	pickerTitle?: string;
	seasonRequests: Array<{ tmdbId: number; seasonNumber: number }>;
	cacheRows: EpisodeCacheRow[];
}) {
	const now = Date.now();
	const cacheByKey = new Map(
		args.cacheRows.map((row) => [episodeCacheKey(row.tmdbId, row.seasonNumber), row] as const)
	);
	const missingRequests = args.seasonRequests.filter(
		(request) => !cacheByKey.has(episodeCacheKey(request.tmdbId, request.seasonNumber))
	);
	const staleRequests = args.seasonRequests.filter((request) => {
		const row = cacheByKey.get(episodeCacheKey(request.tmdbId, request.seasonNumber));
		if (!row) return false;
		return (row.nextRefreshAt ?? 0) <= now;
	});
	const cacheStatus: PickerEpisodesCacheStatus =
		args.seasonRequests.length === 0 || (missingRequests.length === 0 && staleRequests.length === 0)
			? 'fresh'
			: missingRequests.length > 0 && args.cacheRows.length === 0
				? 'empty'
				: missingRequests.length > 0
					? 'partial'
					: 'stale';
	const episodeSeasonCache = new Map(
		args.cacheRows.map((row) => [
			episodeCacheKey(row.tmdbId, row.seasonNumber),
			row.episodes as TMDBSeasonEpisodeRow[]
		])
	);
	return {
		pickerTitle: args.pickerTitle ?? null,
		cacheStatus,
		hasMissingSeasons: missingRequests.length > 0,
		hasStaleSeasons: staleRequests.length > 0,
		missingSeasonCount: missingRequests.length,
		staleSeasonCount: staleRequests.length,
		totalSeasonCount: args.seasonRequests.length,
		episodeSeasonCache
	};
}

export const tryAcquireAnimeLease = internalMutation({
	args: {
		leaseKey: v.string(),
		leaseKind: v.union(v.literal('title_sync'), v.literal('seed_sweep')),
		jobType: v.optional(animeSyncJobTypeValidator),
		tmdbType: v.optional(tmdbTypeValidator),
		tmdbId: v.optional(v.number()),
		seedTable: v.optional(animeSeedTableValidator),
		now: v.number(),
		ttlMs: v.number(),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeSyncLeases')
			.withIndex('by_leaseKey', (q) => q.eq('leaseKey', args.leaseKey))
			.collect();
		const activeLease = rows[0] ?? null;
		const leaseExpiresAt = args.now + args.ttlMs;

		if (!activeLease) {
			const leaseId = await ctx.db.insert('animeSyncLeases', {
				leaseKey: args.leaseKey,
				leaseKind: args.leaseKind,
				jobType: args.jobType,
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				seedTable: args.seedTable,
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return { acquired: true, leaseId, leaseExpiresAt };
		}

		if (activeLease.owner === args.owner || activeLease.leaseExpiresAt <= args.now) {
			await ctx.db.patch(activeLease._id, {
				leaseKey: args.leaseKey,
				leaseKind: args.leaseKind,
				jobType: args.jobType,
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				seedTable: args.seedTable,
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return { acquired: true, leaseId: activeLease._id, leaseExpiresAt };
		}

		return {
			acquired: false,
			leaseId: null,
			leaseExpiresAt: activeLease.leaseExpiresAt
		};
	}
});

export const releaseAnimeLease = internalMutation({
	args: {
		leaseId: v.id('animeSyncLeases'),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const lease = await ctx.db.get(args.leaseId);
		if (!lease) return;
		if (lease.owner !== args.owner) return;
		await ctx.db.delete(args.leaseId);
	}
});

export const upsertAnimeSyncQueueRequest = internalMutation({
	args: {
		jobType: animeSyncJobTypeValidator,
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		priority: v.number(),
		now: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const syncKey = animeSyncQueueKey(args.jobType, args.tmdbType, args.tmdbId);
		const rows = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
			.collect();
		const existing = rows[0] ?? null;
		const force = args.force === true;

		if (!existing) {
			const id = await ctx.db.insert('animeSyncQueue', {
				syncKey,
				jobType: args.jobType,
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				state: 'queued',
				priority: args.priority,
				requestedAt: args.now,
				lastRequestedAt: args.now,
				nextAttemptAt: args.now,
				attemptCount: 0,
				estimatedAniListCost: animeSyncJobDefaultCost(args.jobType)
			});
			return { queued: true, inserted: true, rowId: id };
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
});

export const enqueueStaleAnimeSyncQueueJobs = internalMutation({
	args: {
		now: v.number(),
		jobType: v.optional(animeSyncJobTypeValidator),
		limit: v.optional(v.number()),
		priority: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const limit = Math.max(1, Math.min(args.limit ?? 25, 200));
		const dueRows = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', now))
			.collect();

		let enqueued = 0;
		for (const row of dueRows) {
			if (enqueued >= limit) break;
			if (args.jobType && row.jobType !== args.jobType) continue;
			if (row.state === 'running' || row.state === 'queued' || row.state === 'retry') continue;
			await ctx.db.patch(row._id, {
				state: 'queued',
				nextAttemptAt: now,
				priority: Math.max(
					row.priority,
					args.priority ??
						(row.jobType === 'picker'
							? ANIME_SYNC_QUEUE_BACKGROUND_PICKER_PRIORITY
							: ANIME_SYNC_QUEUE_TIMELINE_PRIORITY)
				),
				lastRequestedAt: now
			});
			enqueued += 1;
		}
		return { enqueued };
	}
});

export const claimNextAnimeSyncQueueJob = internalMutation({
	args: {
		now: v.number(),
		jobType: v.optional(animeSyncJobTypeValidator)
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const candidates: AnimeSyncQueueRow[] = [];
		for (const state of ['queued', 'retry'] as const) {
			const rows = await ctx.db
				.query('animeSyncQueue')
				.withIndex('by_state_nextAttemptAt', (q) => q.eq('state', state).lte('nextAttemptAt', now))
				.collect();
			for (const row of rows) {
				if (args.jobType && row.jobType !== args.jobType) continue;
				candidates.push(row as AnimeSyncQueueRow);
			}
		}
		if (candidates.length === 0) return null;

		candidates.sort((a, b) => {
			if (a.priority !== b.priority) return b.priority - a.priority;
			if (a.nextAttemptAt !== b.nextAttemptAt) return a.nextAttemptAt - b.nextAttemptAt;
			return (b.lastRequestedAt ?? 0) - (a.lastRequestedAt ?? 0);
		});
		const picked = candidates[0];
		await ctx.db.patch(picked._id, {
			state: 'running',
			lastStartedAt: now,
			attemptCount: (picked.attemptCount ?? 0) + 1,
			lastError: undefined
		});
		const next = await ctx.db.get(picked._id);
		return next;
	}
});

export const finishAnimeSyncQueueJob = internalMutation({
	args: {
		rowId: v.id('animeSyncQueue'),
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('retry'), v.literal('error')),
		nextAttemptAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string()),
		animeEligibilityCheck: v.optional(
			v.union(
				v.literal('agree'),
				v.literal('auto_disagree'),
				v.literal('manual_override_disagree'),
				v.literal('db_missing_used_heuristic')
			)
		),
		estimatedAniListCost: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.rowId);
		if (!row) return null;
		const state: Doc<'animeSyncQueue'>['state'] =
			args.outcome === 'success' ? 'idle' : args.outcome === 'retry' ? 'retry' : 'error';
		await ctx.db.patch(args.rowId, {
			state,
			lastFinishedAt: args.now,
			lastSuccessAt: args.outcome === 'success' ? args.now : row.lastSuccessAt,
			nextAttemptAt: args.nextAttemptAt ?? row.nextAttemptAt,
			nextRefreshAt: args.nextRefreshAt ?? row.nextRefreshAt,
			lastError: args.lastError,
			lastResultStatus: args.lastResultStatus ?? row.lastResultStatus,
			animeEligibilityCheck: args.animeEligibilityCheck ?? row.animeEligibilityCheck,
			estimatedAniListCost: args.estimatedAniListCost ?? row.estimatedAniListCost
		});
		return await ctx.db.get(args.rowId);
	}
});

export const reserveAniListBudget = internalMutation({
	args: {
		now: v.number(),
		cost: v.number()
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const requestedCost = Math.max(1, Math.ceil(args.cost));
		const rows = await ctx.db
			.query('animeApiBudget')
			.withIndex('by_provider', (q) => q.eq('provider', 'anilist'))
			.collect();
		const existing = rows[0] ?? null;
		const baseCapacity = existing?.baseCapacity ?? ANILIST_BASE_BUDGET_PER_MIN;
		const baseRefill = existing?.refillPerMinute ?? ANILIST_BASE_BUDGET_PER_MIN;
		const throttleFactor = clampAniListThrottleFactor(existing?.throttleFactor ?? 1);
		const effectiveCapacity = Math.max(1, Math.floor(baseCapacity * throttleFactor));
		const effectiveRefill = Math.max(1, Math.floor(baseRefill * throttleFactor));
		const lastRefillAt = existing?.lastRefillAt ?? now;
		const elapsedMs = Math.max(0, now - lastRefillAt);
		const refilledTokens = Math.min(
			effectiveCapacity,
			(existing?.tokens ?? effectiveCapacity) + (elapsedMs / 60_000) * effectiveRefill
		);
		if (!existing) {
			const id = await ctx.db.insert('animeApiBudget', {
				provider: 'anilist',
				tokens: refilledTokens,
				capacity: effectiveCapacity,
				baseCapacity,
				refillPerMinute: baseRefill,
				lastRefillAt: now,
				throttleFactor,
				consecutive429s: 0,
				updatedAt: now
			});
			const inserted = await ctx.db.get(id);
			if (!inserted) return { reserved: false, nextAllowedAt: now + 60_000, availableTokens: 0 };
			// Continue using the inserted row state below.
		}

		const budgetRow = (await ctx.db
			.query('animeApiBudget')
			.withIndex('by_provider', (q) => q.eq('provider', 'anilist'))
			.collect()
			.then((rows2) => rows2[0])) as AnimeApiBudgetRow | null;
		if (!budgetRow) return { reserved: false, nextAllowedAt: now + 60_000, availableTokens: 0 };

		if ((budgetRow.cooldownUntil ?? 0) > now) {
			await ctx.db.patch(budgetRow._id, {
				tokens: refilledTokens,
				capacity: effectiveCapacity,
				lastRefillAt: now,
				updatedAt: now
			});
			return {
				reserved: false,
				nextAllowedAt: budgetRow.cooldownUntil ?? now + 60_000,
				availableTokens: refilledTokens
			};
		}

		if (refilledTokens < requestedCost) {
			const deficit = requestedCost - refilledTokens;
			const waitMs = Math.ceil((deficit / effectiveRefill) * 60_000);
			await ctx.db.patch(budgetRow._id, {
				tokens: refilledTokens,
				capacity: effectiveCapacity,
				lastRefillAt: now,
				updatedAt: now
			});
			return {
				reserved: false,
				nextAllowedAt: now + Math.max(1_000, waitMs),
				availableTokens: refilledTokens
			};
		}

		const remaining = refilledTokens - requestedCost;
		await ctx.db.patch(budgetRow._id, {
			tokens: remaining,
			capacity: effectiveCapacity,
			lastRefillAt: now,
			updatedAt: now
		});
		return {
			reserved: true,
			nextAllowedAt: now,
			availableTokens: remaining
		};
	}
});

export const recordAniListBudgetOutcome = internalMutation({
	args: {
		now: v.number(),
		outcome: v.union(v.literal('success'), v.literal('rate_limited'), v.literal('failure'))
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const rows = await ctx.db
			.query('animeApiBudget')
			.withIndex('by_provider', (q) => q.eq('provider', 'anilist'))
			.collect();
		const existing = rows[0] ?? null;
		if (!existing) return null;

		const currentFactor = clampAniListThrottleFactor(existing.throttleFactor ?? 1);
		const current429s = existing.consecutive429s ?? 0;
		if (args.outcome === 'success') {
			const next429s = Math.max(0, current429s - 1);
			const nextFactor = clampAniListThrottleFactor(currentFactor + 0.03);
			await ctx.db.patch(existing._id, {
				throttleFactor: nextFactor,
				consecutive429s: next429s,
				cooldownUntil: (existing.cooldownUntil ?? 0) > now ? existing.cooldownUntil : undefined,
				updatedAt: now
			});
			return { throttleFactor: nextFactor, consecutive429s: next429s };
		}

		if (args.outcome === 'rate_limited') {
			const next429s = current429s + 1;
			const nextFactor = clampAniListThrottleFactor(currentFactor * 0.65);
			const cooldownMs = Math.min(10 * 60_000, 60_000 * Math.max(1, next429s));
			await ctx.db.patch(existing._id, {
				throttleFactor: nextFactor,
				consecutive429s: next429s,
				last429At: now,
				cooldownUntil: now + cooldownMs,
				updatedAt: now
			});
			return {
				throttleFactor: nextFactor,
				consecutive429s: next429s,
				cooldownUntil: now + cooldownMs
			};
		}

		await ctx.db.patch(existing._id, {
			updatedAt: now
		});
		return { throttleFactor: currentFactor, consecutive429s: current429s };
	}
});

export const recordAniListBudgetHeaders = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number()),
		remaining: v.optional(v.number()),
		resetAtMs: v.optional(v.number()),
		retryAfterMs: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const rows = await ctx.db
			.query('animeApiBudget')
			.withIndex('by_provider', (q) => q.eq('provider', 'anilist'))
			.collect();
		const existing = rows[0] ?? null;
		if (!existing) return null;

		const currentFactor = clampAniListThrottleFactor(existing.throttleFactor ?? 1);
		const lastRefillAt = existing.lastRefillAt ?? now;
		const elapsedMs = Math.max(0, now - lastRefillAt);
		const currentBaseCapacity = Math.max(
			1,
			Math.floor(existing.baseCapacity ?? ANILIST_BASE_BUDGET_PER_MIN)
		);
		const currentBaseRefill = Math.max(
			1,
			Math.floor(existing.refillPerMinute ?? ANILIST_BASE_BUDGET_PER_MIN)
		);

		const headerLimit =
			typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
				? Math.max(1, Math.floor(args.limit))
				: null;
		const nextBaseCapacity = headerLimit ?? currentBaseCapacity;
		const nextBaseRefill = headerLimit ?? currentBaseRefill;
		const effectiveCapacity = Math.max(1, Math.floor(nextBaseCapacity * currentFactor));
		const effectiveRefill = Math.max(1, Math.floor(nextBaseRefill * currentFactor));
		const refilledTokens = Math.min(
			effectiveCapacity,
			(existing.tokens ?? effectiveCapacity) + (elapsedMs / 60_000) * effectiveRefill
		);

		const headerRemaining =
			typeof args.remaining === 'number' && Number.isFinite(args.remaining) && args.remaining >= 0
				? Math.max(0, Math.floor(args.remaining))
				: null;
		// Conservative sync: never increase local tokens from a concurrent response snapshot.
		const nextTokens =
			headerRemaining == null
				? refilledTokens
				: Math.min(refilledTokens, Math.min(effectiveCapacity, headerRemaining));

		const headerRetryAfterMs =
			typeof args.retryAfterMs === 'number' &&
			Number.isFinite(args.retryAfterMs) &&
			args.retryAfterMs > 0
				? Math.max(1000, Math.floor(args.retryAfterMs))
				: null;
		const headerResetAtMs =
			typeof args.resetAtMs === 'number' && Number.isFinite(args.resetAtMs) && args.resetAtMs > now
				? Math.floor(args.resetAtMs)
				: null;
		let nextCooldownUntil = existing.cooldownUntil;
		if (headerRetryAfterMs != null) {
			nextCooldownUntil = Math.max(nextCooldownUntil ?? 0, now + headerRetryAfterMs);
		}
		if (
			headerResetAtMs != null &&
			(headerRemaining == null || headerRemaining <= 1 || headerRetryAfterMs != null)
		) {
			nextCooldownUntil = Math.max(nextCooldownUntil ?? 0, headerResetAtMs);
		}

		await ctx.db.patch(existing._id, {
			baseCapacity: nextBaseCapacity,
			refillPerMinute: nextBaseRefill,
			capacity: effectiveCapacity,
			tokens: nextTokens,
			lastRefillAt: now,
			cooldownUntil: nextCooldownUntil,
			updatedAt: now
		});
		return {
			baseCapacity: nextBaseCapacity,
			refillPerMinute: nextBaseRefill,
			capacity: effectiveCapacity,
			tokens: nextTokens,
			cooldownUntil: nextCooldownUntil ?? null
		};
	}
});

export const refundAniListBudgetReservation = internalMutation({
	args: {
		now: v.number(),
		refundAmount: v.number()
	},
	handler: async (ctx, args) => {
		const now = args.now;
		const refundAmount = Math.max(0, Math.floor(args.refundAmount));
		if (refundAmount <= 0) return { refunded: 0, tokens: null as number | null };

		const rows = await ctx.db
			.query('animeApiBudget')
			.withIndex('by_provider', (q) => q.eq('provider', 'anilist'))
			.collect();
		const existing = rows[0] ?? null;
		if (!existing) return { refunded: 0, tokens: null as number | null };

		const currentFactor = clampAniListThrottleFactor(existing.throttleFactor ?? 1);
		const baseCapacity = Math.max(
			1,
			Math.floor(existing.baseCapacity ?? ANILIST_BASE_BUDGET_PER_MIN)
		);
		const baseRefill = Math.max(
			1,
			Math.floor(existing.refillPerMinute ?? ANILIST_BASE_BUDGET_PER_MIN)
		);
		const effectiveCapacity = Math.max(1, Math.floor(baseCapacity * currentFactor));
		const effectiveRefill = Math.max(1, Math.floor(baseRefill * currentFactor));
		const lastRefillAt = existing.lastRefillAt ?? now;
		const elapsedMs = Math.max(0, now - lastRefillAt);
		const refilledTokens = Math.min(
			effectiveCapacity,
			(existing.tokens ?? effectiveCapacity) + (elapsedMs / 60_000) * effectiveRefill
		);
		const nextTokens = Math.min(effectiveCapacity, refilledTokens + refundAmount);
		const refunded = Math.max(0, Math.floor(nextTokens - refilledTokens));
		if (refunded <= 0) {
			await ctx.db.patch(existing._id, {
				tokens: refilledTokens,
				capacity: effectiveCapacity,
				lastRefillAt: now,
				updatedAt: now
			});
			return { refunded: 0, tokens: refilledTokens };
		}

		await ctx.db.patch(existing._id, {
			tokens: nextTokens,
			capacity: effectiveCapacity,
			lastRefillAt: now,
			updatedAt: now
		});
		return { refunded, tokens: nextTokens };
	}
});

export const pruneAnimeSyncQueue = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));
		const cutoff = args.now - ANIME_SYNC_QUEUE_PRUNE_AGE_MS;
		const rows = await ctx.db.query('animeSyncQueue').collect();

		let deleted = 0;
		for (const row of rows) {
			if (deleted >= limit) break;
			if (row.state === 'queued' || row.state === 'running') continue;
			if ((row.lastRequestedAt ?? 0) > cutoff) continue;

			const status = row.lastResultStatus ?? '';
			const isSkippedNonAnime =
				status === 'skipped_not_anime_db' ||
				status === 'skipped_non_anime' ||
				status === 'skipped_missing_media_db';
			const isStaleError = row.state === 'error' || row.state === 'retry';

			if (!isSkippedNonAnime && !isStaleError) continue;
			await ctx.db.delete(row._id);
			deleted += 1;
		}

		return { deleted };
	}
});

export const getXrefByTMDB = internalQuery({
	args: { tmdbType: tmdbTypeValidator, tmdbId: v.number() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeXref')
			.withIndex('by_tmdbType_tmdbId', (q) =>
				q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
			)
			.collect();
		return rows[0] ?? null;
	}
});

export const getStoredAnimeEligibilityByTMDB = internalQuery({
	args: { tmdbType: tmdbTypeValidator, tmdbId: v.number() },
	handler: async (ctx, args) => {
		if (args.tmdbType === 'tv') {
			const base = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique();
			const row = base ? await getFinalTV(ctx, base) : null;
			return {
				found: row !== null,
				isAnime: row?.isAnime ?? null,
				isAnimeSource: row?.isAnimeSource ?? null,
				status: row?.status ?? null,
				lastAirDate: row?.lastAirDate ?? null,
				lastEpisodeToAir: row?.lastEpisodeToAir ?? null,
				nextEpisodeToAir: row?.nextEpisodeToAir ?? null,
				releaseDate: row?.releaseDate ?? null
			};
		}
		const base = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
			.unique();
		const row = base ? await getFinalMovie(ctx, base) : null;
		return {
			found: row !== null,
			isAnime: row?.isAnime ?? null,
			isAnimeSource: row?.isAnimeSource ?? null,
			status: row?.status ?? null,
			lastAirDate: null,
			lastEpisodeToAir: null,
			nextEpisodeToAir: null,
			releaseDate: row?.releaseDate ?? null
		};
	}
});

export const getAnimeQueueSeedCandidatesPage = internalQuery({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const limit = Math.max(25, Math.min(args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE, 500));
		const cursor = args.cursor ?? null;
		if (args.table === 'tvShows') {
			const page = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId')
				.order('asc')
				.paginate({ numItems: limit, cursor });
			const candidates: AnimeQueueSeedCandidate[] = [];
			for (const row of page.page) {
				if (typeof row.tmdbId !== 'number') continue;
				const finalRow = await getFinalTV(ctx, row);
				if (finalRow.isAnime !== true) continue;
				candidates.push({ tmdbType: 'tv' as const, tmdbId: row.tmdbId as number });
			}
			return {
				table: args.table,
				scanned: page.page.length,
				candidates,
				done: page.isDone,
				nextCursor: page.isDone ? null : page.continueCursor
			};
		}

		const page = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId')
			.order('asc')
			.paginate({ numItems: limit, cursor });
		const candidates: AnimeQueueSeedCandidate[] = [];
		for (const row of page.page) {
			if (typeof row.tmdbId !== 'number') continue;
			const finalRow = await getFinalMovie(ctx, row);
			if (finalRow.isAnime !== true) continue;
			candidates.push({ tmdbType: 'movie' as const, tmdbId: row.tmdbId as number });
		}
		return {
			table: args.table,
			scanned: page.page.length,
			candidates,
			done: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor
		};
	}
});

export const getAnimePickerEnqueueStatusByTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const eligibility = (await (async () => {
			if (args.tmdbType === 'tv') {
				const base = await ctx.db
					.query('tvShows')
					.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
					.unique();
				const row = base ? await getFinalTV(ctx, base) : null;
				return {
					found: row !== null,
					isAnime: row?.isAnime ?? null
				};
			}
			const base = await ctx.db
				.query('movies')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique();
			const row = base ? await getFinalMovie(ctx, base) : null;
			return {
				found: row !== null,
				isAnime: row?.isAnime ?? null
			};
		})()) as { found: boolean; isAnime: boolean | null };

		if (eligibility.isAnime !== true) {
			return {
				found: eligibility.found,
				isAnime: eligibility.isAnime,
				shouldEnqueue: false,
				reason: eligibility.found ? ('not_anime' as const) : ('missing_media_row' as const)
			};
		}

		const syncKey = animeSyncQueueKey('picker', args.tmdbType, args.tmdbId);
		const queueRow = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_syncKey', (q) => q.eq('syncKey', syncKey))
			.unique();

		if (!queueRow) {
			return {
				found: true,
				isAnime: true as const,
				shouldEnqueue: true,
				reason: 'missing_queue_row' as const
			};
		}

		const isDue = (queueRow.nextRefreshAt ?? 0) <= args.now || queueRow.lastSuccessAt == null;
		const isRecoverableState =
			queueRow.state === 'error' || queueRow.state === 'retry' || queueRow.state === 'idle';
		const shouldEnqueue =
			queueRow.state === 'queued' || queueRow.state === 'running'
				? false
				: isDue || isRecoverableState;

		return {
			found: true,
			isAnime: true as const,
			shouldEnqueue,
			reason: shouldEnqueue
				? ('queue_missing_or_stale' as const)
				: ('queue_fresh_or_active' as const),
			queueState: queueRow.state,
			nextRefreshAt: queueRow.nextRefreshAt ?? null,
			lastSuccessAt: queueRow.lastSuccessAt ?? null
		};
	}
});

export const getTVEpisodeRefreshSignalsByTMDBIds = internalQuery({
	args: {
		tmdbIds: v.array(v.number())
	},
	handler: async (ctx, args) => {
		const uniqueIds = Array.from(new Set(args.tmdbIds));
		const rows: TVEpisodeRefreshSignals[] = [];
		for (const tmdbId of uniqueIds) {
			const base = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
				.unique();
			const row = base ? await getFinalTV(ctx, base) : null;
			if (!row) continue;
			rows.push({
				tmdbId,
				status: row.status ?? null,
				lastAirDate: row.lastAirDate ?? null,
				lastEpisodeToAir: row.lastEpisodeToAir ?? null,
				nextEpisodeToAir: row.nextEpisodeToAir ?? null
			});
		}
		return rows;
	}
});

export const upsertAnimeXrefAuto = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		title: v.object({
			tmdb: v.string(),
			anilistEnglish: v.union(v.string(), v.null()),
			anilistRomaji: v.union(v.string(), v.null())
		}),
		anilistId: v.number(),
		confidence: v.number(),
		method: v.union(v.literal('tmdb_external_ids'), v.literal('title_year_episodes')),
		candidates: v.optional(v.array(animeXrefCandidateValidator))
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeXref')
			.withIndex('by_tmdbType_tmdbId', (q) =>
				q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
			)
			.collect();
		const [existing, ...duplicates] = rows;
		for (const dup of duplicates) {
			await ctx.db.delete(dup._id);
		}

		if (existing?.locked === true) {
			return { row: existing, skippedLocked: true };
		}

		const patch = {
			title: args.title,
			anilistId: args.anilistId,
			confidence: args.confidence,
			method: args.method,
			candidates: args.candidates,
			updatedAt: Date.now()
		} as const;

		if (existing) {
			await ctx.db.patch(existing._id, patch);
			const next = await ctx.db.get(existing._id);
			return { row: next, skippedLocked: false };
		}

		const id = await ctx.db.insert('animeXref', {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			...patch
		});
		const row = await ctx.db.get(id);
		return { row, skippedLocked: false };
	}
});

export const upsertAniListMediaBatch = internalMutation({
	args: {
		items: v.array(
			v.object({
				anilistId: v.number(),
				title: anilistTitleValidator,
				format: v.optional(v.string()),
				startDate: v.optional(anilistDateValidator),
				seasonYear: v.optional(v.number()),
				episodes: v.optional(v.number()),
				description: v.optional(v.string()),
				studios: v.optional(v.array(anilistStudioValidator)),
				watchLinks: v.optional(v.array(anilistWatchLinkValidator))
			})
		),
		schemaVersion: v.number()
	},
	handler: async (ctx, args) => {
		let inserted = 0;
		let updated = 0;
		for (const item of args.items) {
			const rows = await ctx.db
				.query('anilistMedia')
				.withIndex('by_anilistId', (q) => q.eq('anilistId', item.anilistId))
				.collect();
			const [existing, ...duplicates] = rows;
			for (const dup of duplicates) {
				await ctx.db.delete(dup._id);
			}
			const payload = {
				...item,
				fetchedAt: Date.now(),
				schemaVersion: args.schemaVersion
			};
			if (existing) {
				await ctx.db.patch(existing._id, payload);
				updated += 1;
			} else {
				await ctx.db.insert('anilistMedia', payload);
				inserted += 1;
			}
		}
		return { inserted, updated };
	}
});

export const replaceAnimeDisplaySeasonsAuto = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		rows: v.array(
			v.object({
				rowKey: v.string(),
				label: v.string(),
				sortOrder: v.number(),
				rowType: v.union(v.literal('main'), v.literal('specials')),
				seasonOrdinal: v.optional(v.union(v.number(), v.null())),
				episodeNumberingMode: v.optional(
					v.union(v.literal('restarting'), v.literal('continuous'), v.null())
				),
				status: v.optional(
					v.union(
						v.literal('open'),
						v.literal('soft_closed'),
						v.literal('auto_soft_closed'),
						v.literal('closed'),
						v.null()
					)
				),
				hidden: v.optional(v.boolean()),
				sources: v.array(
					v.object({
						tmdbSeasonNumber: v.number(),
						tmdbEpisodeStart: v.union(v.number(), v.null()),
						tmdbEpisodeEnd: v.union(v.number(), v.null()),
						displayAsRegularEpisode: v.optional(v.boolean())
					})
				)
			})
		)
	},
	handler: async (ctx, args) => {
		const titleOverrideRows = await ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const titleOverride = titleOverrideRows[0] ?? null;
		const existingRows = await ctx.db
			.query('animeDisplaySeasons')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const hasExistingRows = existingRows.length > 0;
		const hasManualRows = existingRows.some((row) => row.sourceMode === 'manual');
		if (hasManualRows) {
			// Self-heal mismatched title override metadata. If any manual rows exist, this
			// title is effectively in custom mode and auto replacement must be skipped.
			if (!titleOverride) {
				await ctx.db.insert('animeTitleOverrides', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					displayPlanMode: 'custom',
					updatedAt: Date.now()
				});
			} else if (resolveDisplayPlanMode(titleOverride) !== 'custom') {
				await ctx.db.patch(titleOverride._id, {
					displayPlanMode: 'custom',
					updatedAt: Date.now()
				});
			}
			return { skippedCustom: true, inserted: 0, deleted: 0 };
		}
		if (resolveDisplayPlanMode(titleOverride) === 'custom' && hasExistingRows) {
			return { skippedCustom: true, inserted: 0, deleted: 0 };
		}
		if (resolveDisplayPlanMode(titleOverride) === 'custom' && !hasExistingRows && titleOverride) {
			// Self-heal orphaned custom mode after manual table wipes.
			await ctx.db.patch(titleOverride._id, {
				displayPlanMode: 'auto',
				updatedAt: Date.now()
			});
		}
		let deleted = 0;
		for (const row of existingRows) {
			await ctx.db.delete(row._id);
			deleted += 1;
		}

		const now = Date.now();
		let inserted = 0;
		for (const row of args.rows) {
			await ctx.db.insert('animeDisplaySeasons', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				rowKey: row.rowKey,
				label: row.label,
				sortOrder: row.sortOrder,
				rowType: row.rowType,
				seasonOrdinal: row.seasonOrdinal ?? null,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				status: row.status ?? null,
				hidden: row.hidden ?? false,
				sourceMode: 'auto',
				locked: false,
				sources: row.sources.map((source) => ({
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
					displayAsRegularEpisode: source.displayAsRegularEpisode === true
				})),
				updatedAt: now
			});
			inserted += 1;
		}
		return { skippedCustom: false, inserted, deleted };
	}
});

export const getDisplaySeasonPlan = query({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const [rows, titleOverrideRows] = await Promise.all([
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('animeTitleOverrides')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const titleOverride = titleOverrideRows[0] ?? null;
		const planUpdatedAt = computePlanUpdatedAt(rows);
		return {
			planUpdatedAt,
			titleOverride: titleOverride
				? {
						defaultEpisodeNumberingMode: titleOverride.defaultEpisodeNumberingMode ?? null,
						displayPlanMode: titleOverride.displayPlanMode ?? null,
						displaySeasonCountOverride: titleOverride.displaySeasonCountOverride ?? null
					}
				: null,
			rows: rows
				.slice()
				.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.rowKey.localeCompare(b.rowKey))
				.map((row) => ({
					rowId: row._id,
					rowKey: row.rowKey,
					label: row.label,
					sortOrder: row.sortOrder,
					rowType: row.rowType,
					seasonOrdinal: row.seasonOrdinal ?? null,
					episodeNumberingMode: row.episodeNumberingMode ?? null,
					status: row.status ?? null,
					hidden: row.hidden ?? false,
					sourceMode: row.sourceMode,
					locked: row.locked ?? false,
					sources: normalizeDisplaySeasonSources(row.sources as AnimeDisplaySeasonRow['sources'])
				}))
		};
	}
});

const displaySeasonSourceInputValidator = v.object({
	tmdbSeasonNumber: v.number(),
	tmdbEpisodeStart: v.union(v.number(), v.null()),
	tmdbEpisodeEnd: v.union(v.number(), v.null()),
	displayAsRegularEpisode: v.optional(v.boolean())
});

const displaySeasonRowInputValidator = v.object({
	rowKey: v.string(),
	label: v.string(),
	sortOrder: v.number(),
	rowType: v.union(v.literal('main'), v.literal('specials'), v.literal('custom')),
	seasonOrdinal: v.optional(v.union(v.number(), v.null())),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	),
	status: v.optional(
		v.union(
			v.literal('open'),
			v.literal('soft_closed'),
			v.literal('auto_soft_closed'),
			v.literal('closed'),
			v.null()
		)
	),
	hidden: v.optional(v.boolean()),
	locked: v.optional(v.boolean()),
	sources: v.array(displaySeasonSourceInputValidator)
});

const displaySeasonRowUpdateInputValidator = v.object({
	rowId: v.optional(v.id('animeDisplaySeasons')),
	rowKey: v.string(),
	label: v.string(),
	sortOrder: v.number(),
	rowType: v.union(v.literal('main'), v.literal('specials'), v.literal('custom')),
	seasonOrdinal: v.optional(v.union(v.number(), v.null())),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	),
	status: v.optional(
		v.union(
			v.literal('open'),
			v.literal('soft_closed'),
			v.literal('auto_soft_closed'),
			v.literal('closed'),
			v.null()
		)
	),
	hidden: v.optional(v.boolean()),
	locked: v.optional(v.boolean()),
	sources: v.array(displaySeasonSourceInputValidator)
});

export const replaceDisplaySeasonPlan = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		rows: v.array(displaySeasonRowInputValidator),
		expectedPlanUpdatedAt: v.optional(v.union(v.number(), v.null()))
	},
	handler: async (ctx, args) => {
		const existingRows = await ctx.db
			.query('animeDisplaySeasons')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const currentPlanUpdatedAt = computePlanUpdatedAt(existingRows);
		const expectedPlanUpdatedAt = args.expectedPlanUpdatedAt ?? null;
		if (expectedPlanUpdatedAt != null && expectedPlanUpdatedAt !== currentPlanUpdatedAt) {
			throw new Error(
				`replaceDisplaySeasonPlan: stale plan write (expected ${expectedPlanUpdatedAt}, current ${currentPlanUpdatedAt})`
			);
		}
		const normalizedRows = normalizeDisplaySeasonRowsForWrite(args.rows);
		validateDisplaySeasonPlanRows(normalizedRows);
		for (const row of existingRows) await ctx.db.delete(row._id);

		const now = Date.now();
		const seenRowKeys = new Set<string>();
		for (const row of normalizedRows) {
			const rowKey = row.rowKey.trim();
			if (!rowKey || seenRowKeys.has(rowKey)) {
				throw new Error(`Duplicate or empty rowKey: ${row.rowKey}`);
			}
			seenRowKeys.add(rowKey);
			await ctx.db.insert('animeDisplaySeasons', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				rowKey,
				label: row.label.trim() || rowKey,
				sortOrder: row.sortOrder,
				rowType: row.rowType,
				seasonOrdinal: row.seasonOrdinal,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				status: row.status ?? null,
				hidden: row.hidden ?? false,
				sourceMode: 'manual',
				locked: row.locked ?? false,
				sources: row.sources.map((source) => ({
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
					displayAsRegularEpisode: source.displayAsRegularEpisode === true
				})),
				updatedAt: now
			});
		}

		const titleOverrideRows = await ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const titleOverride = titleOverrideRows[0] ?? null;
		for (const dup of titleOverrideRows.slice(1)) await ctx.db.delete(dup._id);
		if (titleOverride) {
			await ctx.db.patch(titleOverride._id, {
				displayPlanMode: 'custom',
				updatedAt: now
			});
		} else {
			await ctx.db.insert('animeTitleOverrides', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				displayPlanMode: 'custom',
				updatedAt: now
			});
		}
		return { ok: true, rows: normalizedRows.length, planUpdatedAt: now };
	}
});

export const updateAnimeSeasons: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		rows: v.array(displaySeasonRowUpdateInputValidator),
		expectedPlanUpdatedAt: v.optional(v.union(v.number(), v.null()))
	},
	handler: async (ctx, args): Promise<unknown> => {
		const existingRows = (await ctx.runQuery(api.anime.getDisplaySeasonPlan, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId
		})) as {
			planUpdatedAt: number;
			rows: Array<{
				rowId: Id<'animeDisplaySeasons'>;
				rowKey: string;
				label: string;
				sortOrder: number;
				rowType: 'main' | 'specials' | 'custom';
				seasonOrdinal?: number | null;
				episodeNumberingMode?: 'restarting' | 'continuous' | null;
				status?: DisplaySeasonStatus;
				hidden?: boolean;
				locked?: boolean;
				sources: Array<{
					tmdbSeasonNumber: number;
					tmdbEpisodeStart?: number | null;
					tmdbEpisodeEnd?: number | null;
					displayAsRegularEpisode?: boolean;
				}>;
			}>;
		};
		if (
			args.expectedPlanUpdatedAt != null &&
			args.expectedPlanUpdatedAt !== (existingRows.planUpdatedAt ?? 0)
		) {
			throw new Error(
				`updateAnimeSeasons: stale plan snapshot (expected ${args.expectedPlanUpdatedAt}, current ${existingRows.planUpdatedAt ?? 0})`
			);
		}
		const incomingRows: Array<{
			rowId: Id<'animeDisplaySeasons'> | null;
			rowKey: string;
			label: string;
			sortOrder: number;
			rowType: 'main' | 'specials' | 'custom';
			seasonOrdinal: number | null;
			episodeNumberingMode: 'restarting' | 'continuous' | null;
			status: DisplaySeasonStatus;
			hidden: boolean;
			locked: boolean;
			sources: Array<{
				tmdbSeasonNumber: number;
				tmdbEpisodeStart: number | null;
				tmdbEpisodeEnd: number | null;
				displayAsRegularEpisode: boolean;
			}>;
		}> = args.rows.map((row) => ({
			rowId: row.rowId ?? null,
			rowKey: row.rowKey.trim(),
			label: row.label.trim() || row.rowKey.trim(),
			sortOrder: row.sortOrder,
			rowType: row.rowType,
			seasonOrdinal: row.seasonOrdinal ?? null,
			episodeNumberingMode: row.episodeNumberingMode ?? null,
			status: row.status ?? null,
			hidden: row.hidden ?? false,
			locked: row.locked ?? false,
			sources: row.sources.map((source) => ({
				tmdbSeasonNumber: source.tmdbSeasonNumber,
				tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
				tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
				displayAsRegularEpisode: source.displayAsRegularEpisode === true
			}))
		}));
		const existingById = new Map(existingRows.rows.map((row) => [row.rowId, row] as const));
		const seenIncomingRowIds = new Set<Id<'animeDisplaySeasons'>>();
		for (const row of incomingRows) {
			if (row.rowId == null) continue;
			if (seenIncomingRowIds.has(row.rowId)) {
				throw new Error(`updateAnimeSeasons: duplicate rowId in payload: ${row.rowId}`);
			}
			seenIncomingRowIds.add(row.rowId);
			if (!existingById.has(row.rowId)) {
				throw new Error(`updateAnimeSeasons: rowId ${row.rowId} does not exist for this title`);
			}
		}

		const incomingById = new Map(
			incomingRows
				.filter((row) => row.rowId != null)
				.map((row) => [row.rowId as Id<'animeDisplaySeasons'>, row] as const)
		);

		const mergedRows: typeof incomingRows = existingRows.rows.map((row) => {
			const incoming = incomingById.get(row.rowId);
			if (incoming) return incoming;
			return {
				rowId: row.rowId,
				rowKey: row.rowKey,
				label: row.label,
				sortOrder: row.sortOrder,
				rowType: row.rowType,
				seasonOrdinal: row.seasonOrdinal ?? null,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				status: row.status ?? null,
				hidden: row.hidden ?? false,
				locked: row.locked ?? false,
				sources: row.sources.map((source) => ({
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
					displayAsRegularEpisode: source.displayAsRegularEpisode === true
				}))
			};
		});

		const matchedIncoming = new Set<Id<'animeDisplaySeasons'>>();
		for (const row of existingRows.rows) {
			if (incomingById.has(row.rowId)) matchedIncoming.add(row.rowId);
		}
		for (const incomingRow of incomingRows) {
			if (incomingRow.rowId != null && matchedIncoming.has(incomingRow.rowId)) continue;
			mergedRows.push(incomingRow);
		}

		const result = await ctx.runMutation(internal.anime.replaceDisplaySeasonPlan, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			expectedPlanUpdatedAt: existingRows.planUpdatedAt ?? 0,
			rows: mergedRows.map((row) => ({
				rowKey: row.rowKey,
				label: row.label,
				sortOrder: row.sortOrder,
				rowType: row.rowType,
				seasonOrdinal: row.seasonOrdinal,
				episodeNumberingMode: row.episodeNumberingMode,
				status: row.status,
				hidden: row.hidden,
				locked: row.locked,
				sources: row.sources
			}))
		});
		try {
			await ctx.runAction(api.anime.refreshAnimeAlertsForTMDB, {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId
			});
		} catch (error) {
			console.warn('[anime] failed to refresh anime alerts after upserting anime seasons', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				error
			});
		}
		return {
			ok: true,
			mergedRows: mergedRows.length,
			updatedRows: incomingRows.filter((row) => row.rowId != null).length,
			insertedRows: incomingRows.filter((row) => row.rowId == null).length,
			result
		};
	}
});

export const setAnimeDisplayTitleOverrides = mutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		defaultEpisodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		),
		displaySeasonCountOverride: v.optional(v.union(v.number(), v.null())),
		displayPlanMode: v.optional(v.union(v.literal('auto'), v.literal('custom'), v.null()))
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const [existing, ...dups] = rows;
		for (const dup of dups) await ctx.db.delete(dup._id);
		const patch = {
			defaultEpisodeNumberingMode: args.defaultEpisodeNumberingMode,
			displaySeasonCountOverride: args.displaySeasonCountOverride,
			displayPlanMode: args.displayPlanMode,
			updatedAt: Date.now()
		} as const;
		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return { ok: true, rowId: existing._id };
		}
		const id = await ctx.db.insert('animeTitleOverrides', {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			...patch
		});
		return { ok: true, rowId: id };
	}
});

export const resetAnimeSeasonsToAuto: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const existingRows = await ctx.runQuery(api.anime.getDisplaySeasonPlan, args);
		await ctx.runMutation(internal.anime.replaceDisplaySeasonPlan, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			rows: [],
			expectedPlanUpdatedAt: (existingRows as { planUpdatedAt?: number }).planUpdatedAt ?? 0
		});
		await ctx.runMutation(api.anime.setAnimeDisplayTitleOverrides, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			displayPlanMode: 'auto'
		});
		const syncResult = await ctx.runAction(api.anime.syncPickerForTMDB, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			scheduleTimeline: false
		});
		return { ok: true, removedRows: existingRows.rows.length, syncResult };
	}
});

export const getAnimeSeasons = query({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		selectedStableSeasonId: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const [xrefRows, displayRows, titleOverrideRows] = await Promise.all([
			ctx.db
				.query('animeXref')
				.withIndex('by_tmdbType_tmdbId', (q) =>
					q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
				)
				.collect(),
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('animeTitleOverrides')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const xref = xrefRows[0] ?? null;
		const titleOverride = titleOverrideRows[0] ?? null;
		const defaultEpisodeNumberingMode = resolveDefaultEpisodeNumberingMode(titleOverride);

		const pickerBase = (args.tmdbType === 'tv' ? displayRows : [])
			.filter((row) => row.hidden !== true)
			.slice()
			.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.rowKey.localeCompare(b.rowKey))
			.map((row) => {
				const sources = normalizeDisplaySeasonSources(
					row.sources as AnimeDisplaySeasonRow['sources']
				).map((source) => ({
					tmdbType: 'tv',
					tmdbId: args.tmdbId,
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbSeasonName: row.label,
					tmdbEpisodeStart: source.tmdbEpisodeStart,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd,
					displayAsRegularEpisode: source.displayAsRegularEpisode,
					seasonOrdinal: row.seasonOrdinal ?? null,
					episodeNumberingMode: row.episodeNumberingMode ?? null,
					confidence: 1,
					method: row.sourceMode === 'manual' ? 'display_season_manual' : 'display_season_auto',
					locked: row.locked ?? false
				}));
				const syntheticId = syntheticPickerRowStableSeasonId(
					args.tmdbType,
					args.tmdbId,
					row.rowKey
				);
				const estimatedEpisodes = estimateDisplaySeasonEpisodeCount(row);
				const rowEpisodeNumberingMode = row.episodeNumberingMode ?? defaultEpisodeNumberingMode;
				const rowType = row.rowType;
				return {
					stableSeasonId: syntheticId,
					orderIndex: row.sortOrder ?? syntheticId,
					isMainline: rowType !== 'specials',
					isRecap: false,
					discoveredVia: null,
					media: {
						title: {
							english: row.label,
							romaji: row.label,
							native: null
						},
						format: rowType === 'specials' ? 'SPECIAL' : 'TV',
						startDate: null,
						seasonYear: null,
						episodes: estimatedEpisodes,
						description: null,
						studios: [],
						watchLinks: []
					},
					seasonXref:
						sources[0] == null
							? null
							: {
									tmdbType: 'tv',
									tmdbId: args.tmdbId,
									tmdbSeasonNumber: sources[0].tmdbSeasonNumber ?? null,
									tmdbSeasonName: row.label,
									tmdbEpisodeStart: sources[0].tmdbEpisodeStart ?? null,
									tmdbEpisodeEnd: sources[0].tmdbEpisodeEnd ?? null,
									confidence: 1,
									method: row.sourceMode,
									locked: row.locked ?? false
								},
					pickerGroupKey: `display:${row.rowKey}`,
					pickerTitle: row.label,
					seasonOrdinal: row.seasonOrdinal ?? null,
					episodeNumberingMode: rowEpisodeNumberingMode,
					pickerMemberAnilistIds: xref?.anilistId != null ? [xref.anilistId] : [],
					pickerSeasonSources: sources
				};
			});
		const seasonPicker = applyEpisodeDisplayStartsToPickerRows(pickerBase);
		const selected =
			seasonPicker.find((item) => item.stableSeasonId === args.selectedStableSeasonId) ??
			seasonPicker[0] ??
			null;
		const computedDisplaySeasonCount = computeDisplaySeasonCountFromPickerRows(
			seasonPicker,
			'tmdb_seasons'
		);
		const explicitDisplaySeasonCount = titleOverride?.displaySeasonCountOverride ?? null;
		return {
			seasonPicker,
			displaySeasonCount: explicitDisplaySeasonCount ?? computedDisplaySeasonCount,
			selected
		};
	}
});

// Derived safety/attention report for anime display-season plans.
// This query does NOT write DB flags. It computes warnings from:
// - animeDisplaySeasons (rules + row statuses)
// - animeEpisodeCache (cached TMDB episodes)
//
// "unassigned" is a computed condition meaning cached episodes exist but no
// display-season source range currently covers them.
export const listAnimeSeasonReport = query({
	args: {
		maxTitles: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const maxTitles = Math.max(1, Math.min(args.maxTitles ?? 100, 500));
		const allDisplayRows = (await ctx.db.query('animeDisplaySeasons').collect()).filter(
			(row) => row.tmdbType === 'tv' && row.hidden !== true
		);
		const rowsByTitle = new Map<string, typeof allDisplayRows>();
		for (const row of allDisplayRows) {
			const key = `${row.tmdbType}:${row.tmdbId}`;
			const list = rowsByTitle.get(key);
			if (list) list.push(row);
			else rowsByTitle.set(key, [row]);
		}

		const results: Array<{
			tmdbType: 'tv';
			tmdbId: number;
			warnings: string[];
			details: {
				multipleOpenRows: number;
				softClosedOpenEndedRows: string[];
				autoSoftClosedRows: string[];
				unassignedBySeason: Array<{ tmdbSeasonNumber: number; episodeNumbers: number[] }>;
				softClosedOverflow: Array<{
					rowKey: string;
					tmdbSeasonNumber: number;
					episodeNumbers: number[];
				}>;
				missingEpisodeCaches: number[];
			};
		}> = [];

		for (const [, rows] of rowsByTitle) {
			if (results.length >= maxTitles) break;
			const sortedRows = rows
				.slice()
				.sort(
					(a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.rowKey.localeCompare(b.rowKey)
				);
			const openRows = sortedRows.filter((row) => (row.status ?? null) === 'open');
			const multipleOpenRows = openRows.length > 1 ? openRows.length : 0;

			const normalizedRows = sortedRows.map((row) => ({
				rowKey: row.rowKey,
				status: row.status ?? null,
				sources: normalizeDisplaySeasonSources(row.sources as AnimeDisplaySeasonRow['sources'])
			}));

			const referencedSeasons = new Set<number>();
			for (const row of normalizedRows) {
				for (const source of row.sources) referencedSeasons.add(source.tmdbSeasonNumber);
			}

			const firstRow = sortedRows[0];
			const tmdbId = Number(firstRow.tmdbId);
			const cacheRows = await ctx.db
				.query('animeEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', tmdbId))
				.collect();
			const cacheBySeason = new Map(cacheRows.map((cache) => [cache.seasonNumber, cache] as const));

			const missingEpisodeCaches = [...referencedSeasons].filter(
				(seasonNumber) => !cacheBySeason.has(seasonNumber)
			);
			const unassignedBySeason: Array<{ tmdbSeasonNumber: number; episodeNumbers: number[] }> = [];
			const softClosedOverflow: Array<{
				rowKey: string;
				tmdbSeasonNumber: number;
				episodeNumbers: number[];
			}> = [];
			const softClosedOpenEndedRows: string[] = [];
			const autoSoftClosedRows = normalizedRows
				.filter((row) => row.status === 'auto_soft_closed')
				.map((row) => row.rowKey);

			for (const row of normalizedRows) {
				if (!isSoftClosedLikeStatus(row.status as DisplaySeasonStatus)) continue;
				for (const source of row.sources) {
					if (source.tmdbEpisodeEnd == null) softClosedOpenEndedRows.push(row.rowKey);
				}
			}

			for (const seasonNumber of referencedSeasons) {
				const cache = cacheBySeason.get(seasonNumber);
				if (!cache) continue;
				const episodeNumbers = cache.episodes
					.map((episode) => episode.episodeNumber)
					.filter((n) => Number.isFinite(n))
					.sort((a, b) => a - b);

				const assigned = new Set<number>();
				for (const row of normalizedRows) {
					for (const source of row.sources) {
						if (source.tmdbSeasonNumber !== seasonNumber) continue;
						const start = source.tmdbEpisodeStart ?? 1;
						const end = source.tmdbEpisodeEnd ?? Number.POSITIVE_INFINITY;
						for (const n of episodeNumbers) {
							if (n >= start && n <= end) assigned.add(n);
						}
					}
				}

				const unassigned = episodeNumbers.filter((n) => !assigned.has(n));
				if (unassigned.length > 0) {
					unassignedBySeason.push({ tmdbSeasonNumber: seasonNumber, episodeNumbers: unassigned });
				}

				for (const row of normalizedRows) {
					if (!isSoftClosedLikeStatus(row.status as DisplaySeasonStatus)) continue;
					for (const source of row.sources) {
						if (source.tmdbSeasonNumber !== seasonNumber) continue;
						const maxAssigned = source.tmdbEpisodeEnd ?? source.tmdbEpisodeStart ?? null;
						if (maxAssigned == null) continue;
						const overflow = episodeNumbers.filter((n) => n > maxAssigned);
						if (overflow.length > 0) {
							softClosedOverflow.push({
								rowKey: row.rowKey,
								tmdbSeasonNumber: seasonNumber,
								episodeNumbers: overflow
							});
						}
					}
				}
			}

			// Warning codes are query-derived (not persisted):
			// - multiple_open_rows: operator ambiguity; more than one row may accept future episodes
			// - soft_closed_open_ended: contradictory config (soft_closed row still has open-ended range)
			// - soft_closed_overflow: cached episodes exist past a soft_closed row's assigned end
			// - unassigned_episodes: cached episodes are not covered by any display-season row
			const warnings: string[] = [];
			if (multipleOpenRows > 0) warnings.push('multiple_open_rows');
			if (softClosedOpenEndedRows.length > 0) warnings.push('soft_closed_open_ended');
			if (softClosedOverflow.length > 0) warnings.push('soft_closed_overflow');
			if (unassignedBySeason.length > 0) warnings.push('unassigned_episodes');
			if (missingEpisodeCaches.length > 0) warnings.push('missing_episode_cache');
			if (warnings.length === 0) continue;

			results.push({
				tmdbType: 'tv',
				tmdbId,
				warnings,
				details: {
					multipleOpenRows,
					softClosedOpenEndedRows: [...new Set(softClosedOpenEndedRows)],
					autoSoftClosedRows: [...new Set(autoSoftClosedRows)],
					unassignedBySeason,
					softClosedOverflow,
					missingEpisodeCaches
				}
			});
		}

		return {
			items: results,
			totalFlagged: results.length
		};
	}
});

export const autoSoftCloseAnimeSeasonsForTMDB = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		if (args.tmdbType !== 'tv') {
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		}
		const [tvBase, titleOverrideRows] = await Promise.all([
			ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique(),
			ctx.db
				.query('animeTitleOverrides')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const tvRow = tvBase ? await getFinalTV(ctx, tvBase) : null;
		if (!tvRow)
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		const titleOverride = titleOverrideRows[0] ?? null;
		if (resolveDisplayPlanMode(titleOverride) !== 'custom') {
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		}

		const statusLower = (tvRow.status ?? '').toLowerCase();
		const isEnded =
			statusLower.includes('ended') ||
			statusLower.includes('cancelled') ||
			statusLower.includes('canceled');
		if (isEnded)
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		if (tvRow.nextEpisodeToAir != null) {
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		}
		const daysSinceLastEpisode = daysSinceDate(Date.now(), tvRow.lastEpisodeToAir?.airDate ?? null);
		if (daysSinceLastEpisode == null || daysSinceLastEpisode < 180) {
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		}
		const targetSeasonNumber = tvRow.lastEpisodeToAir?.seasonNumber ?? null;
		if (targetSeasonNumber == null) {
			return { ok: true, updated: 0, rowKeys: [] as string[], blockedRowKeys: [] as string[] };
		}

		const [rows, cacheRows] = await Promise.all([
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', 'tv').eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('animeEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const now = Date.now();
		const updatedRowKeys: string[] = [];
		const blockedRowKeys: string[] = [];
		const latestAiredEpisodeBySeason = new Map<number, number>();
		for (const cacheRow of cacheRows) {
			let maxEpisode: number | null = null;
			for (const episode of cacheRow.episodes) {
				if (!Number.isFinite(episode.episodeNumber)) continue;
				const airMs = parseDateMs(episode.airDate);
				if (airMs != null && airMs > now) continue;
				maxEpisode =
					maxEpisode == null ? episode.episodeNumber : Math.max(maxEpisode, episode.episodeNumber);
			}
			if (maxEpisode != null) {
				latestAiredEpisodeBySeason.set(cacheRow.seasonNumber, maxEpisode);
			}
		}
		for (const row of rows) {
			if ((row.status ?? null) !== 'open') continue;
			const sources = normalizeDisplaySeasonSources(
				row.sources as AnimeDisplaySeasonRow['sources']
			);
			const openEndedSources = sources.filter((source) => source.tmdbEpisodeEnd == null);
			if (openEndedSources.length === 0) continue;
			const hasOpenEndedSeasonSource = openEndedSources.some(
				(source) => source.tmdbSeasonNumber === targetSeasonNumber && source.tmdbEpisodeEnd == null
			);
			if (!hasOpenEndedSeasonSource) continue;
			const cappedBySourceIndex = new Map<number, number>();
			let canSafelyCapAllOpenEnded = true;
			for (let index = 0; index < sources.length; index += 1) {
				const source = sources[index]!;
				if (source.tmdbEpisodeEnd != null) continue;
				const start = source.tmdbEpisodeStart ?? 1;
				let candidateEnd = latestAiredEpisodeBySeason.get(source.tmdbSeasonNumber) ?? null;
				if (
					source.tmdbSeasonNumber === targetSeasonNumber &&
					Number.isFinite(tvRow.lastEpisodeToAir?.episodeNumber ?? null)
				) {
					candidateEnd = Math.max(candidateEnd ?? 0, tvRow.lastEpisodeToAir?.episodeNumber ?? 0);
				}
				if (candidateEnd == null || candidateEnd < start) {
					canSafelyCapAllOpenEnded = false;
					break;
				}
				cappedBySourceIndex.set(index, candidateEnd);
			}
			if (!canSafelyCapAllOpenEnded) {
				blockedRowKeys.push(row.rowKey);
				continue;
			}
			const cappedSources = sources.map((source, index) => {
				if (source.tmdbEpisodeEnd != null) return source;
				const cappedEnd = cappedBySourceIndex.get(index);
				if (cappedEnd == null) return source;
				return {
					...source,
					tmdbEpisodeEnd: cappedEnd
				};
			});
			await ctx.db.patch(row._id, {
				status: 'auto_soft_closed',
				sources: cappedSources.map((source) => ({
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
					displayAsRegularEpisode: source.displayAsRegularEpisode === true
				})),
				updatedAt: now
			});
			updatedRowKeys.push(row.rowKey);
		}
		return { ok: true, updated: updatedRowKeys.length, rowKeys: updatedRowKeys, blockedRowKeys };
	}
});

export const autoCreateNextAnimeSeasonForTMDB = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		if (args.tmdbType !== 'tv') {
			return { ok: true, created: false, reason: 'not_tv' as const };
		}

		const [titleOverrideRows, tvBase, allRows] = await Promise.all([
			ctx.db
				.query('animeTitleOverrides')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
				.unique(),
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const tvRow = tvBase ? await getFinalTV(ctx, tvBase) : null;

		const titleOverride = titleOverrideRows[0] ?? null;
		if (resolveDisplayPlanMode(titleOverride) !== 'custom') {
			return { ok: true, created: false, reason: 'not_custom_mode' as const };
		}
		if (!tvRow) {
			return { ok: true, created: false, reason: 'missing_tv_row' as const };
		}

		const mainRows = allRows
			.filter((row) => row.rowType === 'main')
			.slice()
			.sort(
				(a, b) =>
					(a.seasonOrdinal ?? Number.NEGATIVE_INFINITY) -
						(b.seasonOrdinal ?? Number.NEGATIVE_INFINITY) ||
					(a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
					a.rowKey.localeCompare(b.rowKey)
			);
		if (mainRows.length === 0) {
			return { ok: true, created: false, reason: 'missing_main_rows' as const };
		}
		if (mainRows.some((row) => (row.status ?? null) === 'open')) {
			return { ok: true, created: false, reason: 'open_row_exists' as const };
		}

		const latestMain = mainRows[mainRows.length - 1]!;
		if ((latestMain.status ?? null) !== 'closed') {
			return { ok: true, created: false, reason: 'latest_row_not_closed' as const };
		}

		const latestSources = normalizeDisplaySeasonSources(
			latestMain.sources as AnimeDisplaySeasonRow['sources']
		).filter((source) => source.tmdbSeasonNumber > 0);
		if (latestSources.length === 0) {
			return { ok: true, created: false, reason: 'latest_row_no_main_sources' as const };
		}
		if (latestSources.some((source) => source.tmdbEpisodeEnd == null)) {
			return { ok: true, created: false, reason: 'latest_row_unbounded' as const };
		}

		let latestCoveragePoint: EpisodePoint | null = null;
		for (const source of latestSources) {
			const end = source.tmdbEpisodeEnd;
			if (end == null) continue;
			const point: EpisodePoint = {
				tmdbSeasonNumber: source.tmdbSeasonNumber,
				tmdbEpisodeNumber: end
			};
			if (!latestCoveragePoint || compareEpisodePoint(point, latestCoveragePoint) > 0) {
				latestCoveragePoint = point;
			}
		}
		if (!latestCoveragePoint) {
			return { ok: true, created: false, reason: 'unable_to_compute_latest_coverage' as const };
		}

		const allSources = allRows.flatMap((row) =>
			normalizeDisplaySeasonSources(row.sources as AnimeDisplaySeasonRow['sources'])
		);
		const nextEpisodePoint = episodePointFromTVEpisode(tvRow.nextEpisodeToAir);
		const candidateFromNext =
			nextEpisodePoint &&
			nextEpisodePoint.tmdbSeasonNumber > 0 &&
			compareEpisodePoint(nextEpisodePoint, latestCoveragePoint) > 0 &&
			!anySourceCoversEpisodePoint(allSources, nextEpisodePoint)
				? nextEpisodePoint
				: null;

		const cacheRows = await ctx.db
			.query('animeEpisodeCache')
			.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', args.tmdbId))
			.collect();
		const now = Date.now();
		let candidateFromEpisodes: EpisodePoint | null = null;
		for (const cache of cacheRows) {
			if (cache.seasonNumber <= 0) continue;
			for (const episode of cache.episodes) {
				const point: EpisodePoint = {
					tmdbSeasonNumber: cache.seasonNumber,
					tmdbEpisodeNumber: episode.episodeNumber
				};
				if (compareEpisodePoint(point, latestCoveragePoint) <= 0) continue;
				if (anySourceCoversEpisodePoint(allSources, point)) continue;
				if (!candidateFromEpisodes || compareEpisodePoint(point, candidateFromEpisodes) < 0) {
					candidateFromEpisodes = point;
				}
			}
		}

		let candidate: EpisodePoint | null = null;
		if (candidateFromNext && candidateFromEpisodes) {
			candidate =
				compareEpisodePoint(candidateFromNext, candidateFromEpisodes) <= 0
					? candidateFromNext
					: candidateFromEpisodes;
		} else {
			candidate = candidateFromNext ?? candidateFromEpisodes;
		}
		if (!candidate) {
			return { ok: true, created: false, reason: 'no_unmapped_future_point' as const };
		}

		const ordinalCandidates = mainRows
			.map((row) => row.seasonOrdinal ?? null)
			.filter((value): value is number => value != null && Number.isFinite(value));
		const nextOrdinal =
			ordinalCandidates.length > 0 ? Math.max(...ordinalCandidates) + 1 : mainRows.length + 1;
		const nextSortOrder = nextOrdinal;
		const rowKeyBase = `auto:s${nextOrdinal}`;
		const existingRowKeys = new Set(allRows.map((row) => row.rowKey));
		let rowKey = rowKeyBase;
		if (existingRowKeys.has(rowKey)) {
			rowKey = `${rowKeyBase}:${candidate.tmdbSeasonNumber}:${candidate.tmdbEpisodeNumber}`;
		}
		let suffix = 2;
		while (existingRowKeys.has(rowKey)) {
			rowKey = `${rowKeyBase}:${suffix}`;
			suffix += 1;
		}

		const prospectiveRows = allRows.map((row) => ({
			rowKey: row.rowKey,
			rowType: row.rowType,
			status: (row.status ?? null) as DisplaySeasonStatus,
			sources: normalizeDisplaySeasonSources(row.sources as AnimeDisplaySeasonRow['sources']).map(
				(source) => ({
					tmdbSeasonNumber: source.tmdbSeasonNumber,
					tmdbEpisodeStart: source.tmdbEpisodeStart,
					tmdbEpisodeEnd: source.tmdbEpisodeEnd,
					displayAsRegularEpisode: source.displayAsRegularEpisode
				})
			)
		}));
		prospectiveRows.push({
			rowKey,
			rowType: 'main',
			status: 'open',
			sources: [
				{
					tmdbSeasonNumber: candidate.tmdbSeasonNumber,
					tmdbEpisodeStart: candidate.tmdbEpisodeNumber,
					tmdbEpisodeEnd: null,
					displayAsRegularEpisode: false
				}
			]
		});
		validateDisplaySeasonPlanRows(prospectiveRows);

		const createdId = await ctx.db.insert('animeDisplaySeasons', {
			tmdbType: 'tv',
			tmdbId: args.tmdbId,
			rowKey,
			label: `Season ${nextOrdinal}`,
			sortOrder: nextSortOrder,
			rowType: 'main',
			seasonOrdinal: nextOrdinal,
			episodeNumberingMode: null,
			status: 'open',
			hidden: false,
			sourceMode: 'manual',
			locked: false,
			sources: [
				{
					tmdbSeasonNumber: candidate.tmdbSeasonNumber,
					tmdbEpisodeStart: candidate.tmdbEpisodeNumber,
					tmdbEpisodeEnd: null,
					displayAsRegularEpisode: false
				}
			],
			updatedAt: now
		});

		return {
			ok: true,
			created: true,
			rowId: createdId,
			rowKey,
			tmdbSeasonNumber: candidate.tmdbSeasonNumber,
			tmdbEpisodeStart: candidate.tmdbEpisodeNumber
		};
	}
});

const animeAlertScopeTypeValidator = v.union(
	v.literal('title'),
	v.literal('display_row'),
	v.literal('tmdb_season'),
	v.literal('xref')
);
const animeAlertSeverityValidator = v.union(
	v.literal('info'),
	v.literal('warning'),
	v.literal('error')
);
const animeAlertStatusValidator = v.union(
	v.literal('open'),
	v.literal('acknowledged'),
	v.literal('resolved')
);
const animeAlertSourceValidator = v.union(v.literal('season_report'), v.literal('needs_review'));

export const getAnimeSeasonReportForTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		if (args.tmdbType !== 'tv') {
			return null;
		}
		const rows = (
			await ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		).filter((row) => row.hidden !== true);
		if (rows.length === 0) return null;

		const sortedRows = rows
			.slice()
			.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.rowKey.localeCompare(b.rowKey));
		const openRows = sortedRows.filter((row) => (row.status ?? null) === 'open');
		const multipleOpenRows = openRows.length > 1 ? openRows.length : 0;
		const normalizedRows = sortedRows.map((row) => ({
			rowKey: row.rowKey,
			status: row.status ?? null,
			sources: normalizeDisplaySeasonSources(row.sources as AnimeDisplaySeasonRow['sources'])
		}));
		const referencedSeasons = new Set<number>();
		for (const row of normalizedRows) {
			for (const source of row.sources) referencedSeasons.add(source.tmdbSeasonNumber);
		}
		const cacheRows = await ctx.db
			.query('animeEpisodeCache')
			.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', args.tmdbId))
			.collect();
		const cacheBySeason = new Map(cacheRows.map((cache) => [cache.seasonNumber, cache] as const));
		const missingEpisodeCaches = [...referencedSeasons].filter(
			(seasonNumber) => !cacheBySeason.has(seasonNumber)
		);
		const unassignedBySeason: Array<{ tmdbSeasonNumber: number; episodeNumbers: number[] }> = [];
		const softClosedOverflow: Array<{
			rowKey: string;
			tmdbSeasonNumber: number;
			episodeNumbers: number[];
		}> = [];
		const softClosedOpenEndedRows: string[] = [];
		const autoSoftClosedRows = normalizedRows
			.filter((row) => row.status === 'auto_soft_closed')
			.map((row) => row.rowKey);
		const transitionalRows = normalizedRows
			.filter((row) => isSoftClosedLikeStatus(row.status as DisplaySeasonStatus))
			.map((row) => ({
				rowKey: row.rowKey,
				status: row.status as 'soft_closed' | 'auto_soft_closed'
			}));
		const softCloseSuggestions: Array<{
			rowKey: string;
			tmdbSeasonNumber: number;
			daysSinceLastEpisode: number;
		}> = [];
		const inactiveSeasonReviewRows: Array<{
			rowKey: string;
			tmdbSeasonNumber: number;
			daysSinceLastEpisode: number;
		}> = [];
		let upcomingEpisodeUnmapped: EpisodePoint | null = null;

		for (const row of normalizedRows) {
			if (!isSoftClosedLikeStatus(row.status as DisplaySeasonStatus)) continue;
			for (const source of row.sources) {
				if (source.tmdbEpisodeEnd == null) softClosedOpenEndedRows.push(row.rowKey);
			}
		}
		for (const seasonNumber of referencedSeasons) {
			const cache = cacheBySeason.get(seasonNumber);
			if (!cache) continue;
			const episodeNumbers = cache.episodes
				.map((episode) => episode.episodeNumber)
				.filter((n) => Number.isFinite(n))
				.sort((a, b) => a - b);
			const assigned = new Set<number>();
			for (const row of normalizedRows) {
				for (const source of row.sources) {
					if (source.tmdbSeasonNumber !== seasonNumber) continue;
					const start = source.tmdbEpisodeStart ?? 1;
					const end = source.tmdbEpisodeEnd ?? Number.POSITIVE_INFINITY;
					for (const n of episodeNumbers) {
						if (n >= start && n <= end) assigned.add(n);
					}
				}
			}
			const unassigned = episodeNumbers.filter((n) => !assigned.has(n));
			if (unassigned.length > 0) {
				unassignedBySeason.push({ tmdbSeasonNumber: seasonNumber, episodeNumbers: unassigned });
			}
			for (const row of normalizedRows) {
				if (!isSoftClosedLikeStatus(row.status as DisplaySeasonStatus)) continue;
				for (const source of row.sources) {
					if (source.tmdbSeasonNumber !== seasonNumber) continue;
					const maxAssigned = source.tmdbEpisodeEnd ?? source.tmdbEpisodeStart ?? null;
					if (maxAssigned == null) continue;
					const overflow = episodeNumbers.filter((n) => n > maxAssigned);
					if (overflow.length > 0) {
						softClosedOverflow.push({
							rowKey: row.rowKey,
							tmdbSeasonNumber: seasonNumber,
							episodeNumbers: overflow
						});
					}
				}
			}
		}
		const tvBase = await ctx.db
			.query('tvShows')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
			.unique();
		const tvRow = tvBase ? await getFinalTV(ctx, tvBase) : null;
		if (tvRow) {
			const statusLower = (tvRow.status ?? '').toLowerCase();
			const isEnded =
				statusLower.includes('ended') ||
				statusLower.includes('cancelled') ||
				statusLower.includes('canceled');
			const lastEpisode = tvRow.lastEpisodeToAir ?? null;
			const nextEpisode = tvRow.nextEpisodeToAir ?? null;
			const nextEpisodePoint = episodePointFromTVEpisode(nextEpisode);
			if (nextEpisodePoint && nextEpisodePoint.tmdbSeasonNumber > 0) {
				const allSources = normalizedRows.flatMap((row) => row.sources);
				if (!anySourceCoversEpisodePoint(allSources, nextEpisodePoint)) {
					upcomingEpisodeUnmapped = nextEpisodePoint;
				}
			}
			const daysSinceLastEpisode = daysSinceDate(Date.now(), lastEpisode?.airDate ?? null);
			if (
				!isEnded &&
				nextEpisode == null &&
				lastEpisode &&
				daysSinceLastEpisode != null &&
				daysSinceLastEpisode >= 90
			) {
				for (const row of normalizedRows) {
					if ((row.status ?? null) !== 'open') continue;
					for (const source of row.sources) {
						if (source.tmdbSeasonNumber !== lastEpisode.seasonNumber) continue;
						if (source.tmdbEpisodeEnd != null) continue;
						inactiveSeasonReviewRows.push({
							rowKey: row.rowKey,
							tmdbSeasonNumber: source.tmdbSeasonNumber,
							daysSinceLastEpisode
						});
						break;
					}
				}
			}
			if (
				!isEnded &&
				nextEpisode == null &&
				lastEpisode &&
				daysSinceLastEpisode != null &&
				daysSinceLastEpisode >= 14
			) {
				for (const row of normalizedRows) {
					if ((row.status ?? null) !== 'open') continue;
					for (const source of row.sources) {
						if (source.tmdbSeasonNumber !== lastEpisode.seasonNumber) continue;
						if (source.tmdbEpisodeEnd != null) continue;
						softCloseSuggestions.push({
							rowKey: row.rowKey,
							tmdbSeasonNumber: source.tmdbSeasonNumber,
							daysSinceLastEpisode
						});
						break;
					}
				}
			}
		}
		const warnings: string[] = [];
		if (multipleOpenRows > 0) warnings.push('multiple_open_rows');
		if (softClosedOpenEndedRows.length > 0) warnings.push('soft_closed_open_ended');
		if (softClosedOverflow.length > 0) warnings.push('soft_closed_overflow');
		if (unassignedBySeason.length > 0) warnings.push('unassigned_episodes');
		if (missingEpisodeCaches.length > 0) warnings.push('missing_episode_cache');
		if (softCloseSuggestions.length > 0) warnings.push('suggest_soft_closed');
		if (inactiveSeasonReviewRows.length > 0) warnings.push('inactive_season_review');
		if (transitionalRows.length > 0) warnings.push('transitional_status_review_required');
		if (upcomingEpisodeUnmapped) warnings.push('upcoming_episode_unmapped');
		return {
			tmdbType: 'tv' as const,
			tmdbId: args.tmdbId,
			warnings,
			details: {
				multipleOpenRows,
				softClosedOpenEndedRows: [...new Set(softClosedOpenEndedRows)],
				autoSoftClosedRows: [...new Set(autoSoftClosedRows)],
				transitionalRows,
				inactiveSeasonReviewRows,
				upcomingEpisodeUnmapped,
				unassignedBySeason,
				softClosedOverflow,
				missingEpisodeCaches,
				softCloseSuggestions
			}
		};
	}
});

export const getAnimeNeedsReviewSignalsForTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		xrefThreshold: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const xrefThreshold = args.xrefThreshold ?? 0.82;
		const [xrefs, titleOverrides, displayRows] = await Promise.all([
			ctx.db
				.query('animeXref')
				.withIndex('by_tmdbType_tmdbId', (q) =>
					q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
				)
				.collect(),
			ctx.db
				.query('animeTitleOverrides')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect(),
			ctx.db
				.query('animeDisplaySeasons')
				.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
				.collect()
		]);
		const xref = xrefs[0] ?? null;
		const titleOverride = titleOverrides[0] ?? null;
		const queueRow = await ctx.db
			.query('animeSyncQueue')
			.withIndex('by_syncKey', (q) =>
				q.eq('syncKey', animeSyncQueueKey('picker', args.tmdbType, args.tmdbId))
			)
			.unique();
		return {
			lowXrefConfidence:
				xref &&
				xref.locked !== true &&
				Number.isFinite(xref.confidence) &&
				xref.confidence < xrefThreshold
					? {
							anilistId: xref.anilistId,
							confidence: xref.confidence
						}
					: null,
			unresolvedXrefMatch:
				xref == null && queueRow?.lastResultStatus === 'unresolved'
					? {
							lastResultStatus: queueRow.lastResultStatus ?? null,
							lastError: queueRow.lastError ?? null,
							lastFinishedAt: queueRow.lastFinishedAt ?? null
						}
					: null,
			customDisplayPlan: titleOverride?.displayPlanMode === 'custom' && displayRows.length > 0
		};
	}
});

const animeAlertDraftValidator = v.object({
	tmdbType: tmdbTypeValidator,
	tmdbId: v.number(),
	scopeType: animeAlertScopeTypeValidator,
	scopeKey: v.union(v.string(), v.null()),
	code: v.string(),
	severity: animeAlertSeverityValidator,
	source: animeAlertSourceValidator,
	summary: v.string(),
	detailsJson: v.union(v.string(), v.null()),
	fingerprint: v.string()
});

export const replaceAnimeAlertsForTMDB = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		alerts: v.array(animeAlertDraftValidator)
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query('animeAlerts')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect();
		const existingByFingerprint = new Map(existing.map((row) => [row.fingerprint, row] as const));
		const incomingFingerprints = new Set(args.alerts.map((alert) => alert.fingerprint));

		for (const alert of args.alerts) {
			const existingRow = existingByFingerprint.get(alert.fingerprint);
			if (existingRow) {
				await ctx.db.patch(existingRow._id, {
					scopeType: alert.scopeType,
					scopeKey: alert.scopeKey,
					code: alert.code,
					severity: alert.severity,
					source: alert.source,
					summary: alert.summary,
					detailsJson: alert.detailsJson,
					lastDetectedAt: now,
					lastSeenAt: now,
					resolvedAt: incomingFingerprints.has(alert.fingerprint)
						? null
						: (existingRow.resolvedAt ?? null),
					status: existingRow.status === 'resolved' ? 'open' : existingRow.status,
					updatedAt: now
				});
				continue;
			}
			await ctx.db.insert('animeAlerts', {
				tmdbType: alert.tmdbType,
				tmdbId: alert.tmdbId,
				scopeType: alert.scopeType,
				scopeKey: alert.scopeKey,
				code: alert.code,
				severity: alert.severity,
				status: 'open',
				source: alert.source,
				fingerprint: alert.fingerprint,
				summary: alert.summary,
				detailsJson: alert.detailsJson,
				firstDetectedAt: now,
				lastDetectedAt: now,
				lastSeenAt: now,
				resolvedAt: null,
				updatedAt: now
			});
		}

		for (const row of existing) {
			if (incomingFingerprints.has(row.fingerprint)) continue;
			if (row.code === 'missing_episode_cache') {
				await ctx.db.delete(row._id);
				continue;
			}
			if (row.status !== 'resolved') {
				await ctx.db.patch(row._id, {
					status: 'resolved',
					resolvedAt: now,
					lastSeenAt: now,
					updatedAt: now
				});
				continue;
			}
			if (
				(row.resolvedAt ?? 0) > 0 &&
				now - (row.resolvedAt ?? 0) > ANIME_ALERT_RESOLVED_RETENTION_MS
			) {
				await ctx.db.delete(row._id);
			}
		}

		return { ok: true, alerts: args.alerts.length };
	}
});

export const refreshAnimeAlertsForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const autoSoftCloseResult = (await ctx.runMutation(
			internal.anime.autoSoftCloseAnimeSeasonsForTMDB,
			args
		)) as {
			ok: boolean;
			updated: number;
			rowKeys: string[];
			blockedRowKeys: string[];
		};
		const autoCreateLeaseOwner = createAnimeSyncLeaseOwner();
		const autoCreateLease = (await ctx.runMutation(internal.anime.tryAcquireAnimeLease, {
			leaseKey:
				animeTitleSyncLeaseKey('picker', args.tmdbType, args.tmdbId) + ':auto_create_season',
			leaseKind: 'title_sync',
			jobType: 'picker',
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			now: Date.now(),
			ttlMs: 30_000,
			owner: autoCreateLeaseOwner
		})) as { acquired: boolean; leaseId: Id<'animeSyncLeases'> | null };
		let autoCreateResult: {
			ok: boolean;
			created: boolean;
			reason?: string;
			rowId?: Id<'animeDisplaySeasons'>;
			rowKey?: string;
			tmdbSeasonNumber?: number;
			tmdbEpisodeStart?: number;
		} = { ok: true, created: false, reason: 'auto_create_lock_busy' };
		try {
			if (autoCreateLease.acquired && autoCreateLease.leaseId) {
				autoCreateResult = (await ctx.runMutation(
					internal.anime.autoCreateNextAnimeSeasonForTMDB,
					args
				)) as {
					ok: boolean;
					created: boolean;
					reason?: string;
					rowId?: Id<'animeDisplaySeasons'>;
					rowKey?: string;
					tmdbSeasonNumber?: number;
					tmdbEpisodeStart?: number;
				};
			}
		} finally {
			if (autoCreateLease.acquired && autoCreateLease.leaseId) {
				await ctx.runMutation(internal.anime.releaseAnimeLease, {
					leaseId: autoCreateLease.leaseId,
					owner: autoCreateLeaseOwner
				});
			}
		}
		const seasonReport = (await ctx.runQuery(internal.anime.getAnimeSeasonReportForTMDB, args)) as {
			tmdbType: 'tv';
			tmdbId: number;
			warnings: string[];
			details: {
				multipleOpenRows: number;
				softClosedOpenEndedRows: string[];
				autoSoftClosedRows: string[];
				transitionalRows: Array<{ rowKey: string; status: 'soft_closed' | 'auto_soft_closed' }>;
				inactiveSeasonReviewRows: Array<{
					rowKey: string;
					tmdbSeasonNumber: number;
					daysSinceLastEpisode: number;
				}>;
				upcomingEpisodeUnmapped: { tmdbSeasonNumber: number; tmdbEpisodeNumber: number } | null;
				unassignedBySeason: Array<{ tmdbSeasonNumber: number; episodeNumbers: number[] }>;
				softClosedOverflow: Array<{
					rowKey: string;
					tmdbSeasonNumber: number;
					episodeNumbers: number[];
				}>;
				missingEpisodeCaches: number[];
				softCloseSuggestions: Array<{
					rowKey: string;
					tmdbSeasonNumber: number;
					daysSinceLastEpisode: number;
				}>;
			};
		} | null;
		const reviewSignals = (await ctx.runQuery(
			internal.anime.getAnimeNeedsReviewSignalsForTMDB,
			args
		)) as {
			lowXrefConfidence: { anilistId: number; confidence: number } | null;
			unresolvedXrefMatch: {
				lastResultStatus: string | null;
				lastError: string | null;
				lastFinishedAt: number | null;
			} | null;
			customDisplayPlan: boolean;
		};

		const alerts: AnimeAlertDraft[] = [];
		for (const rowKey of autoSoftCloseResult.blockedRowKeys ?? []) {
			alerts.push({
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				scopeType: 'display_row',
				scopeKey: rowKey,
				code: 'auto_soft_close_blocked',
				severity: 'warning',
				source: 'season_report',
				summary: `Auto soft-close skipped for row ${rowKey}; at least one open-ended source could not be safely bounded`,
				detailsJson: JSON.stringify({ rowKey }),
				fingerprint: animeAlertFingerprint([
					'season_report',
					args.tmdbType,
					args.tmdbId,
					'auto_soft_close_blocked',
					rowKey
				])
			});
		}
		if (autoCreateResult.created === true && autoCreateResult.rowKey) {
			alerts.push({
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				scopeType: 'display_row',
				scopeKey: autoCreateResult.rowKey,
				code: 'auto_created_season',
				severity: 'info',
				source: 'season_report',
				summary: `Automatically created ${autoCreateResult.rowKey} from TMDB S${autoCreateResult.tmdbSeasonNumber}E${autoCreateResult.tmdbEpisodeStart}`,
				detailsJson: JSON.stringify({
					rowId: autoCreateResult.rowId ?? null,
					rowKey: autoCreateResult.rowKey,
					tmdbSeasonNumber: autoCreateResult.tmdbSeasonNumber ?? null,
					tmdbEpisodeStart: autoCreateResult.tmdbEpisodeStart ?? null
				}),
				fingerprint: animeAlertFingerprint([
					'season_report',
					args.tmdbType,
					args.tmdbId,
					'auto_created_season',
					autoCreateResult.rowKey
				])
			});
		}
		if (reviewSignals.lowXrefConfidence) {
			const details = reviewSignals.lowXrefConfidence;
			alerts.push({
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				scopeType: 'xref',
				scopeKey: `anilist:${details.anilistId}`,
				code: 'low_xref_confidence',
				severity: 'warning',
				source: 'needs_review',
				summary: `AniList title anchor confidence is low (${details.confidence.toFixed(2)})`,
				detailsJson: JSON.stringify(details),
				fingerprint: animeAlertFingerprint([
					'needs_review',
					args.tmdbType,
					args.tmdbId,
					'low_xref_confidence',
					details.anilistId
				])
			});
		}
		if (reviewSignals.unresolvedXrefMatch) {
			const details = reviewSignals.unresolvedXrefMatch;
			alerts.push({
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				scopeType: 'title',
				scopeKey: null,
				code: 'unresolved_xref_match',
				severity: 'warning',
				source: 'needs_review',
				summary: 'AniList title anchor unresolved after matching attempts',
				detailsJson: JSON.stringify(details),
				fingerprint: animeAlertFingerprint([
					'needs_review',
					args.tmdbType,
					args.tmdbId,
					'unresolved_xref_match'
				])
			});
		}
		if (reviewSignals.customDisplayPlan) {
			alerts.push({
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				scopeType: 'title',
				scopeKey: null,
				code: 'custom_display_plan',
				severity: 'info',
				source: 'needs_review',
				summary: 'Title is using a custom display-season plan',
				detailsJson: null,
				fingerprint: animeAlertFingerprint([
					'needs_review',
					args.tmdbType,
					args.tmdbId,
					'custom_display_plan'
				])
			});
		}

		if (seasonReport) {
			if (seasonReport.details.multipleOpenRows > 0) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'title',
					scopeKey: null,
					code: 'multiple_open_rows',
					severity: 'error',
					source: 'season_report',
					summary: `${seasonReport.details.multipleOpenRows} display-season rows are marked open`,
					detailsJson: JSON.stringify({ multipleOpenRows: seasonReport.details.multipleOpenRows }),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'multiple_open_rows'
					])
				});
			}
			for (const rowKey of seasonReport.details.softClosedOpenEndedRows) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'display_row',
					scopeKey: rowKey,
					code: 'soft_closed_open_ended',
					severity: 'error',
					source: 'season_report',
					summary: `soft_closed row ${rowKey} still has an open-ended source range`,
					detailsJson: JSON.stringify({ rowKey }),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'soft_closed_open_ended',
						rowKey
					])
				});
			}
			for (const item of seasonReport.details.softClosedOverflow) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'display_row',
					scopeKey: item.rowKey,
					code: 'soft_closed_overflow',
					severity: 'warning',
					source: 'season_report',
					summary: `Episodes exist past soft_closed row ${item.rowKey} in TMDB season ${item.tmdbSeasonNumber}`,
					detailsJson: JSON.stringify(item),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'soft_closed_overflow',
						item.rowKey,
						item.tmdbSeasonNumber
					])
				});
			}
			for (const item of seasonReport.details.unassignedBySeason) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'tmdb_season',
					scopeKey: `season:${item.tmdbSeasonNumber}`,
					code: 'unassigned_episodes',
					severity: 'warning',
					source: 'season_report',
					summary: `TMDB season ${item.tmdbSeasonNumber} has episodes not covered by display-season ranges`,
					detailsJson: JSON.stringify(item),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'unassigned_episodes',
						item.tmdbSeasonNumber
					])
				});
			}
			if (
				seasonReport.details.upcomingEpisodeUnmapped &&
				seasonReport.details.unassignedBySeason.length === 0 &&
				seasonReport.details.softClosedOverflow.length === 0
			) {
				const point = seasonReport.details.upcomingEpisodeUnmapped;
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'tmdb_season',
					scopeKey: `season:${point.tmdbSeasonNumber}`,
					code: 'upcoming_episode_unmapped',
					severity: 'warning',
					source: 'season_report',
					summary: `Upcoming TMDB S${point.tmdbSeasonNumber}E${point.tmdbEpisodeNumber} is not mapped to any display season`,
					detailsJson: JSON.stringify(point),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'upcoming_episode_unmapped',
						point.tmdbSeasonNumber,
						point.tmdbEpisodeNumber
					])
				});
			}
			for (const seasonNumber of seasonReport.details.missingEpisodeCaches) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'tmdb_season',
					scopeKey: `season:${seasonNumber}`,
					code: 'missing_episode_cache',
					severity: 'info',
					source: 'season_report',
					summary: `TMDB season ${seasonNumber} is referenced by display seasons but has no episode cache yet`,
					detailsJson: JSON.stringify({ tmdbSeasonNumber: seasonNumber }),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'missing_episode_cache',
						seasonNumber
					])
				});
			}
			for (const item of seasonReport.details.softCloseSuggestions) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'display_row',
					scopeKey: item.rowKey,
					code: 'suggest_soft_closed',
					severity: 'info',
					source: 'season_report',
					summary: `Row ${item.rowKey} may be ready for soft_close (${item.daysSinceLastEpisode} days since last aired episode)`,
					detailsJson: JSON.stringify(item),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'suggest_soft_closed',
						item.rowKey,
						item.tmdbSeasonNumber
					])
				});
			}
			for (const item of seasonReport.details.inactiveSeasonReviewRows) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'display_row',
					scopeKey: item.rowKey,
					code: 'inactive_season_review',
					severity: 'warning',
					source: 'season_report',
					summary: `Open row ${item.rowKey} has no next episode and has been inactive for ${item.daysSinceLastEpisode} days`,
					detailsJson: JSON.stringify(item),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'inactive_season_review',
						item.rowKey
					])
				});
			}
			for (const item of seasonReport.details.transitionalRows) {
				alerts.push({
					tmdbType: 'tv',
					tmdbId: seasonReport.tmdbId,
					scopeType: 'display_row',
					scopeKey: item.rowKey,
					code: 'transitional_status_review_required',
					severity: 'warning',
					source: 'season_report',
					summary: `Row ${item.rowKey} is in transitional status (${item.status}); review and set to open or closed`,
					detailsJson: JSON.stringify(item),
					fingerprint: animeAlertFingerprint([
						'season_report',
						'tv',
						seasonReport.tmdbId,
						'transitional_status_review_required',
						item.rowKey
					])
				});
			}
		}

		await ctx.runMutation(internal.anime.replaceAnimeAlertsForTMDB, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			alerts
		});
		return { ok: true, alerts: alerts.length };
	}
});

export const listAnimeAlerts = query({
	args: {
		status: v.optional(animeAlertStatusValidator),
		maxItems: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const maxItems = Math.max(1, Math.min(args.maxItems ?? 200, 500));
		const rows = args.status
			? await ctx.db
					.query('animeAlerts')
					.withIndex('by_status_lastSeenAt', (q) => q.eq('status', args.status!))
					.order('desc')
					.take(maxItems)
			: await ctx.db.query('animeAlerts').collect();
		const items = (
			args.status ? rows : rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, maxItems)
		).map((row) => ({
			_id: row._id,
			tmdbType: row.tmdbType,
			tmdbId: row.tmdbId,
			scopeType: row.scopeType,
			scopeKey: row.scopeKey ?? null,
			code: row.code,
			severity: row.severity,
			status: row.status,
			source: row.source,
			summary: row.summary,
			detailsJson: row.detailsJson ?? null,
			firstDetectedAt: row.firstDetectedAt,
			lastDetectedAt: row.lastDetectedAt,
			lastSeenAt: row.lastSeenAt,
			resolvedAt: row.resolvedAt ?? null,
			fingerprint: row.fingerprint
		}));
		return { items, total: items.length };
	}
});

export const setAnimeAlertStatus = mutation({
	args: {
		alertId: v.id('animeAlerts'),
		status: v.union(v.literal('acknowledged'), v.literal('resolved'), v.literal('open'))
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.alertId);
		if (!row) throw new Error('animeAlerts row not found');
		const now = Date.now();
		await ctx.db.patch(args.alertId, {
			status: args.status,
			resolvedAt: args.status === 'resolved' ? now : null,
			lastSeenAt: now,
			updatedAt: now
		});
		return { ok: true };
	}
});

export const getAnimeAlertSweepState = internalQuery({
	args: {
		table: animeSeedTableValidator
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeAlertSweepState')
			.withIndex('by_table', (q) => q.eq('table', args.table))
			.collect();
		return rows[0] ?? null;
	}
});

export const upsertAnimeAlertSweepState = internalMutation({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		lastRunAt: v.optional(v.union(v.number(), v.null()))
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('animeAlertSweepState')
			.withIndex('by_table', (q) => q.eq('table', args.table))
			.collect();
		const [existing, ...dups] = rows;
		for (const dup of dups) await ctx.db.delete(dup._id);
		const patch = {
			cursor: args.cursor ?? null,
			lastRunAt: args.lastRunAt ?? null,
			updatedAt: Date.now()
		};
		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('animeAlertSweepState', {
			table: args.table,
			...patch
		});
		return { ok: true, rowId };
	}
});

export const sweepAnimeAlertsMaterialized = internalAction({
	args: {
		table: v.optional(animeSeedTableValidator),
		limitPerTable: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const tables: Array<'tvShows' | 'movies'> = args.table ? [args.table] : ['tvShows', 'movies'];
		const limitPerTable = Math.max(10, Math.min(args.limitPerTable ?? 40, 200));
		const now = Date.now();
		const results: Array<{
			table: 'tvShows' | 'movies';
			scanned: number;
			processed: number;
			done: boolean;
			nextCursor: string | null;
		}> = [];

		for (const table of tables) {
			const sweepState = (await ctx.runQuery(internal.anime.getAnimeAlertSweepState, {
				table
			})) as { cursor?: string | null } | null;
			const page = (await ctx.runQuery(internal.anime.getAnimeQueueSeedCandidatesPage, {
				table,
				cursor: sweepState?.cursor ?? null,
				limit: limitPerTable
			})) as {
				table: 'tvShows' | 'movies';
				scanned: number;
				candidates: AnimeQueueSeedCandidate[];
				done: boolean;
				nextCursor: string | null;
			};

			let processed = 0;
			for (const candidate of page.candidates) {
				try {
					await ctx.runAction(api.anime.refreshAnimeAlertsForTMDB, {
						tmdbType: candidate.tmdbType,
						tmdbId: candidate.tmdbId
					});
					processed += 1;
				} catch (error) {
					console.warn('[anime] failed to materialize alerts during cron sweep', {
						table,
						tmdbType: candidate.tmdbType,
						tmdbId: candidate.tmdbId,
						error
					});
				}
			}

			await ctx.runMutation(internal.anime.upsertAnimeAlertSweepState, {
				table,
				cursor: page.done ? null : page.nextCursor,
				lastRunAt: now
			});

			results.push({
				table,
				scanned: page.scanned,
				processed,
				done: page.done,
				nextCursor: page.done ? null : page.nextCursor
			});
		}

		return { ok: true, results };
	}
});

export const getPickerEpisodes = action({
	args: {
		pickerTitle: v.optional(v.string()),
		sources: v.array(pickerSeasonSourceValidator),
		numberingRows: v.optional(v.array(pickerNumberingRowValidator)),
		selectedPickerRowKey: v.optional(v.string()),
		episodeDisplayStart: v.optional(v.union(v.number(), v.null())),
		episodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		)
	},
	handler: async (ctx, args) => {
		const normalizedSources = normalizePickerSourcesForEpisodes(args.sources);
		const seasonRequests = seasonRequestsForPickerSources(normalizedSources);
		const episodeSeasonCache = await fetchSeasonEpisodesWithCache(ctx, seasonRequests);
		let computedEpisodeDisplayStart: number | null = null;
		if (
			(args.episodeNumberingMode ?? null) === 'continuous' &&
			args.numberingRows &&
			args.selectedPickerRowKey
		) {
			computedEpisodeDisplayStart = await computeEpisodeDisplayStartFromNumberingRows(
				args.numberingRows.map((row) => ({
					pickerRowKey: row.pickerRowKey,
					episodeNumberingMode: row.episodeNumberingMode ?? null,
					sources: row.sources
				})),
				args.selectedPickerRowKey,
				episodeSeasonCache,
				true
			);
		}
		const episodes = await fetchEpisodesForPickerSources(normalizedSources, episodeSeasonCache, {
			episodeDisplayStart: computedEpisodeDisplayStart ?? args.episodeDisplayStart ?? null,
			episodeNumberingMode: args.episodeNumberingMode ?? null
		});
		return {
			pickerTitle: args.pickerTitle ?? null,
			episodes,
			cacheStatus: seasonRequests.length === 0 ? 'fresh' : 'fresh',
			hasMissingSeasons: false,
			hasStaleSeasons: false,
			missingSeasonCount: 0,
			staleSeasonCount: 0,
			totalSeasonCount: seasonRequests.length
		};
	}
});

export const getPickerEpisodesCached = query({
	args: {
		pickerTitle: v.optional(v.string()),
		sources: v.array(pickerSeasonSourceValidator),
		numberingRows: v.optional(v.array(pickerNumberingRowValidator)),
		selectedPickerRowKey: v.optional(v.string()),
		episodeDisplayStart: v.optional(v.union(v.number(), v.null())),
		episodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		)
	},
	handler: async (ctx, args) => {
		const normalizedSources = normalizePickerSourcesForEpisodes(args.sources);
		const seasonRequests = seasonRequestsForPickerSources(normalizedSources);
		const cacheRows = await getEpisodeCacheRowsFromDB(ctx, seasonRequests);
		const payload = buildPickerEpisodesCachedPayload({
			pickerTitle: args.pickerTitle,
			seasonRequests,
			cacheRows
		});
		let computedEpisodeDisplayStart: number | null = null;
		if (
			(args.episodeNumberingMode ?? null) === 'continuous' &&
			args.numberingRows &&
			args.selectedPickerRowKey
		) {
			const numberingRows = args.numberingRows.map((row) => ({
				pickerRowKey: row.pickerRowKey,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				sources: row.sources
			}));
			const numberingSeasonRequests = seasonRequestsForContinuousNumberingRows(
				numberingRows,
				args.selectedPickerRowKey
			);
			const numberingCacheRows = await getEpisodeCacheRowsFromDB(ctx, numberingSeasonRequests);
			const numberingSeasonCache = new Map(payload.episodeSeasonCache);
			for (const row of numberingCacheRows) {
				numberingSeasonCache.set(
					episodeCacheKey(row.tmdbId, row.seasonNumber),
					row.episodes as TMDBSeasonEpisodeRow[]
				);
			}
			computedEpisodeDisplayStart = await computeEpisodeDisplayStartFromNumberingRows(
				numberingRows,
				args.selectedPickerRowKey,
				numberingSeasonCache,
				false
			);
		}
		const episodes = await fetchEpisodesForPickerSources(
			normalizedSources,
			payload.episodeSeasonCache,
			{
				allowNetworkFetch: false,
				episodeDisplayStart: computedEpisodeDisplayStart ?? args.episodeDisplayStart ?? null,
				episodeNumberingMode: args.episodeNumberingMode ?? null
			}
		);
		return {
			pickerTitle: payload.pickerTitle,
			episodes,
			cacheStatus: payload.cacheStatus,
			hasMissingSeasons: payload.hasMissingSeasons,
			hasStaleSeasons: payload.hasStaleSeasons,
			missingSeasonCount: payload.missingSeasonCount,
			staleSeasonCount: payload.staleSeasonCount,
			totalSeasonCount: payload.totalSeasonCount
		};
	}
});

export const refreshPickerEpisodesCache = action({
	args: {
		pickerTitle: v.optional(v.string()),
		sources: v.array(pickerSeasonSourceValidator),
		numberingRows: v.optional(v.array(pickerNumberingRowValidator)),
		selectedPickerRowKey: v.optional(v.string()),
		episodeDisplayStart: v.optional(v.union(v.number(), v.null())),
		episodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		)
	},
	handler: async (ctx, args) => {
		const normalizedSources = normalizePickerSourcesForEpisodes(args.sources);
		const seasonRequests = seasonRequestsForPickerSources(normalizedSources);
		let refreshRequests = seasonRequests;
		if (
			(args.episodeNumberingMode ?? null) === 'continuous' &&
			args.numberingRows &&
			args.selectedPickerRowKey
		) {
			refreshRequests = seasonRequestsForContinuousNumberingRows(
				args.numberingRows.map((row) => ({
					pickerRowKey: row.pickerRowKey,
					episodeNumberingMode: row.episodeNumberingMode ?? null,
					sources: row.sources
				})),
				args.selectedPickerRowKey
			);
		}
		await fetchSeasonEpisodesWithCache(ctx, refreshRequests);
		const tmdbIds = new Set(refreshRequests.map((r) => r.tmdbId));
		for (const tmdbId of tmdbIds) {
			try {
				await ctx.runAction(api.anime.refreshAnimeAlertsForTMDB, {
					tmdbType: 'tv',
					tmdbId
				});
			} catch (error) {
				console.warn('[anime] failed to refresh anime alerts after episode cache refresh', {
					tmdbType: 'tv',
					tmdbId,
					error
				});
			}
		}
		return {
			ok: true,
			refreshed: refreshRequests.length
		};
	}
});

type AnimeSyncCoreArgs = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
	forceNonAnime?: boolean;
	forceRematch?: boolean;
};

// Action context is passed from Convex actions in this module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAnimeSyncForTMDB(ctx: any, args: AnimeSyncCoreArgs, syncMode: 'picker' | 'full') {
	const aniListMetrics = createAniListRequestMetrics();
	const source = await fetchTMDBAnimeSource(args.tmdbType as MediaType, args.tmdbId);
	const episodeBoundsBySeason =
		source.tmdbType === 'tv'
			? buildEpisodeBoundsBySeasonFromCacheRows(
					((await ctx.runQuery(animeInternal.anime.getEpisodeCachesBySeasons, {
						requests: source.seasons.map((season) => ({
							tmdbId: source.tmdbId,
							seasonNumber: season.seasonNumber
						}))
					})) as EpisodeCacheRow[]) ?? []
				)
			: undefined;
	const storedEligibility = (await ctx.runQuery(
		animeInternal.anime.getStoredAnimeEligibilityByTMDB,
		{
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId
		}
	)) as StoredAnimeRefreshSignals | null;
	const storedIsAnime = storedEligibility?.isAnime ?? null;
	// Audit signal for DB-vs-heuristic anime classification. `auto_disagree` is the
	// problematic case to surface in audits; manual override disagreement is expected.
	const animeEligibilityCheck =
		storedIsAnime == null
			? 'db_missing_used_heuristic'
			: storedIsAnime === source.isLikelyAnime
				? 'agree'
				: storedEligibility?.isAnimeSource === 'manual'
					? 'manual_override_disagree'
					: 'auto_disagree';
	const shouldTreatAsAnime =
		args.forceNonAnime === true
			? true
			: storedIsAnime != null
				? storedIsAnime === true
				: source.isLikelyAnime;
	if (!shouldTreatAsAnime) {
		return {
			ok: false,
			status: 'skipped_non_anime',
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			syncMode,
			animeEligibilityCheck,
			...summarizeAniListRunMetrics(aniListMetrics)
		} as const;
	}

	const existingXref = (await ctx.runQuery(animeInternal.anime.getXrefByTMDB, {
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId
	})) as AnimeXrefRow | null;

	let anchorAnilistId = existingXref?.anilistId ?? null;
	let matchMeta:
		| {
				confidence: number;
				candidates: { anilistId: number; score: number; why?: string }[];
				reason?: string;
		  }
		| undefined;

	if (existingXref?.locked !== true || anchorAnilistId === null || args.forceRematch === true) {
		const candidateRows: AniListMediaCore[] = [];
		for (const term of buildSearchTerms(source.title, source.originalTitle)) {
			const found = await searchAniListAnimeCandidates(term, 10, aniListMetrics);
			candidateRows.push(...found);
		}

		const dedupedCandidates = dedupeById(candidateRows);
		const match = matchTMDBAnimeToAniListCandidates(source, dedupedCandidates);
		matchMeta = {
			confidence: match.confidence,
			candidates: match.candidates,
			reason: match.reason
		};

		if (match.accepted && match.selected) {
			const write = (await ctx.runMutation(animeInternal.anime.upsertAnimeXrefAuto, {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				title: {
					tmdb: source.title,
					anilistEnglish: match.selected.title.english ?? null,
					anilistRomaji: match.selected.title.romaji ?? null
				},
				anilistId: match.selected.id,
				confidence: match.confidence,
				method: match.method,
				candidates: match.candidates
			})) as { row: AnimeXrefRow | null; skippedLocked: boolean };
			const row: AnimeXrefRow | null = write.row;
			anchorAnilistId = row?.anilistId ?? anchorAnilistId;
		}
	}

	if (anchorAnilistId === null) {
		// No AniList anchor is acceptable for picker/episodes. We still seed TMDB-based
		// display seasons so the anime can render in-app without studio enrichment.
		const autoRows = buildAutoDisplaySeasonRowsFromTMDBSource(source, episodeBoundsBySeason);
		const displaySeasonWrite = await ctx.runMutation(
			animeInternal.anime.replaceAnimeDisplaySeasonsAuto,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				rows: autoRows
			}
		);
		if (args.tmdbType === 'tv') {
			await ctx.runMutation(animeInternal.anime.reconcileAutoDisplaySeasonBoundsFromEpisodeCache, {
				tmdbId: args.tmdbId
			});
		}
		return {
			ok: true,
			status: 'synced_tmdb_only',
			syncMode,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			anchorAnilistId: null,
			displaySeasonRowsStored: autoRows.length,
			displaySeasonWrite,
			match: matchMeta,
			animeEligibilityCheck,
			...summarizeAniListRunMetrics(aniListMetrics)
		} as const;
	}

	try {
		const anchorMedia = await fetchAniListAnimeMediaById(anchorAnilistId, aniListMetrics);
		await ctx.runMutation(animeInternal.anime.upsertAniListMediaBatch, {
			items: [toCachePayload(anchorMedia)],
			schemaVersion: 1
		});
	} catch (error) {
		console.warn('[anime] failed to cache AniList anchor media', {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			anchorAnilistId,
			error
		});
	}

	const autoRows = buildAutoDisplaySeasonRowsFromTMDBSource(source, episodeBoundsBySeason);
	const displaySeasonWrite = await ctx.runMutation(
		animeInternal.anime.replaceAnimeDisplaySeasonsAuto,
		{
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			rows: autoRows
		}
	);
	if (args.tmdbType === 'tv') {
		await ctx.runMutation(animeInternal.anime.reconcileAutoDisplaySeasonBoundsFromEpisodeCache, {
			tmdbId: args.tmdbId
		});
	}

	return {
		ok: true,
		status: 'synced',
		syncMode,
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId,
		anchorAnilistId,
		displaySeasonRowsStored: autoRows.length,
		displaySeasonWrite,
		match: matchMeta,
		animeEligibilityCheck,
		...summarizeAniListRunMetrics(aniListMetrics)
	} as const;
}

async function runAnimeSyncWithLease(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx: any,
	args: AnimeSyncCoreArgs,
	options: { jobType: 'picker' | 'timeline'; syncMode: 'picker' | 'full'; leaseTtlMs: number }
) {
	const now = Date.now();
	const leaseOwner = createAnimeSyncLeaseOwner(now);
	const lease = (await ctx.runMutation(animeInternal.anime.tryAcquireAnimeLease, {
		leaseKey: animeTitleSyncLeaseKey(options.jobType, args.tmdbType, args.tmdbId),
		leaseKind: 'title_sync',
		jobType: options.jobType,
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId,
		now,
		ttlMs: options.leaseTtlMs,
		owner: leaseOwner
	})) as { acquired: boolean; leaseId: Id<'animeSyncLeases'> | null; leaseExpiresAt: number };

	if (!lease.acquired || lease.leaseId === null) {
		return {
			ok: true,
			status: 'skipped_busy',
			jobType: options.jobType,
			syncMode: options.syncMode,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			leaseExpiresAt: lease.leaseExpiresAt
		} as const;
	}

	try {
		const result = await runAnimeSyncForTMDB(ctx, args, options.syncMode);
		if (result.ok === true && result.status === 'synced') {
			try {
				await ctx.runMutation(animeInternal.details.syncAnimeCreatorCreditsForTMDB, {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId
				});
			} catch (error) {
				console.warn('[anime] failed to sync anime creator credits onto detail row', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}
		return result;
	} finally {
		await ctx.runMutation(animeInternal.anime.releaseAnimeLease, {
			leaseId: lease.leaseId,
			owner: leaseOwner
		});
	}
}

export const requestPickerRefreshForTMDB = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const eligibility = (await ctx.runQuery(animeInternal.anime.getStoredAnimeEligibilityByTMDB, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId
		})) as StoredAnimeRefreshSignals;
		if (eligibility.isAnime !== true && args.force !== true) {
			return {
				ok: true,
				queued: false,
				reason: eligibility.found ? 'not_anime' : 'missing_media_row'
			};
		}

		const queued = await ctx.runMutation(animeInternal.anime.upsertAnimeSyncQueueRequest, {
			jobType: 'picker',
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			priority: ANIME_SYNC_QUEUE_INTERACTIVE_PICKER_PRIORITY,
			now,
			force: args.force
		});

		if (queued.queued) {
			try {
				await ctx.scheduler.runAfter(0, internal.anime.processAnimeSyncQueue, {
					maxJobs: 1,
					jobType: 'picker'
				});
			} catch (error) {
				console.warn('[anime] failed to schedule anime queue worker after enqueue', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}

		return {
			ok: true,
			queued
		};
	}
});

export const seedAnimeSyncQueueFromStoredMedia = internalAction({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
		leaseOwner: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const leaseOwner = args.leaseOwner ?? createAnimeSyncLeaseOwner(now);
		const lease = (await ctx.runMutation(animeInternal.anime.tryAcquireAnimeLease, {
			leaseKey: animeSeedSweepLeaseKey(args.table),
			leaseKind: 'seed_sweep',
			seedTable: args.table,
			now,
			ttlMs: ANIME_QUEUE_SEED_SWEEP_LEASE_TTL_MS,
			owner: leaseOwner
		})) as { acquired: boolean; leaseId: Id<'animeSyncLeases'> | null; leaseExpiresAt: number };
		if (!lease.acquired || lease.leaseId === null) {
			return {
				table: args.table,
				scanned: 0,
				animeCandidates: 0,
				inserted: 0,
				queued: 0,
				done: false,
				nextCursor: args.cursor ?? null,
				status: 'skipped_busy' as const,
				leaseExpiresAt: lease.leaseExpiresAt
			};
		}

		let continuationScheduled = false;
		let pageDone = false;

		try {
			const page = (await ctx.runQuery(animeInternal.anime.getAnimeQueueSeedCandidatesPage, {
				table: args.table,
				cursor: args.cursor ?? null,
				limit: args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE
			})) as {
				table: 'tvShows' | 'movies';
				scanned: number;
				candidates: AnimeQueueSeedCandidate[];
				done: boolean;
				nextCursor: string | null;
			};

			let inserted = 0;
			let queued = 0;
			for (const candidate of page.candidates) {
				const result = (await ctx.runMutation(animeInternal.anime.upsertAnimeSyncQueueRequest, {
					jobType: 'picker',
					tmdbType: candidate.tmdbType,
					tmdbId: candidate.tmdbId,
					priority: ANIME_SYNC_QUEUE_BACKGROUND_PICKER_PRIORITY,
					now
				})) as { queued: boolean; inserted: boolean };
				if (result.inserted) inserted += 1;
				if (result.queued) queued += 1;
			}

			if (queued > 0) {
				try {
					await ctx.scheduler.runAfter(0, internal.anime.processAnimeSyncQueue, {
						maxJobs: 1,
						jobType: 'picker'
					});
				} catch (error) {
					console.warn(
						'[anime] failed to schedule queue processor after seeding anime sync queue',
						{
							table: args.table,
							error
						}
					);
				}
			}

			if (!page.done && page.nextCursor) {
				try {
					await ctx.scheduler.runAfter(0, internal.anime.seedAnimeSyncQueueFromStoredMedia, {
						table: args.table,
						cursor: page.nextCursor,
						limit: args.limit ?? ANIME_QUEUE_SEED_PAGE_SIZE,
						leaseOwner
					});
					continuationScheduled = true;
				} catch (error) {
					console.warn('[anime] failed to schedule continuation for anime queue seed sweep', {
						table: args.table,
						error
					});
				}
			}

			pageDone = page.done;

			return {
				table: page.table,
				scanned: page.scanned,
				animeCandidates: page.candidates.length,
				inserted,
				queued,
				done: page.done,
				nextCursor: page.nextCursor
			};
		} finally {
			if (pageDone || !continuationScheduled) {
				await ctx.runMutation(animeInternal.anime.releaseAnimeLease, {
					leaseId: lease.leaseId,
					owner: leaseOwner
				});
			}
		}
	}
});

export const enqueueStaleAnimePickerRefreshes = internalAction({
	args: {
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		return await ctx.runMutation(animeInternal.anime.enqueueStaleAnimeSyncQueueJobs, {
			now: Date.now(),
			jobType: 'picker',
			limit: args.limit ?? 50,
			priority: ANIME_SYNC_QUEUE_BACKGROUND_PICKER_PRIORITY
		});
	}
});

export const processAnimeSyncQueue = internalAction({
	args: {
		maxJobs: v.optional(v.number()),
		jobType: v.optional(animeSyncJobTypeValidator)
	},
	handler: async (ctx, args) => {
		const maxJobs = Math.max(1, Math.min(args.maxJobs ?? 3, 10));
		const now = Date.now();
		await ctx.runMutation(animeInternal.anime.pruneAnimeSyncQueue, {
			now,
			limit: 100
		});
		await ctx.runMutation(animeInternal.anime.enqueueStaleAnimeSyncQueueJobs, {
			now,
			jobType: args.jobType,
			limit: 25,
			priority:
				args.jobType === 'timeline'
					? ANIME_SYNC_QUEUE_TIMELINE_PRIORITY
					: ANIME_SYNC_QUEUE_BACKGROUND_PICKER_PRIORITY
		});

		let processed = 0;
		let rateLimited = false;
		for (let i = 0; i < maxJobs; i += 1) {
			const claim = (await ctx.runMutation(animeInternal.anime.claimNextAnimeSyncQueueJob, {
				now: Date.now(),
				jobType: args.jobType
			})) as AnimeSyncQueueRow | null;
			if (!claim) break;

			const eligibility = (await ctx.runQuery(animeInternal.anime.getStoredAnimeEligibilityByTMDB, {
				tmdbType: claim.tmdbType,
				tmdbId: claim.tmdbId
			})) as StoredAnimeRefreshSignals;
			if (eligibility.isAnime !== true) {
				await ctx.runMutation(animeInternal.anime.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: 'success',
					nextRefreshAt: Date.now() + 30 * 24 * 60 * 60_000,
					lastError: undefined,
					lastResultStatus: eligibility.found ? 'skipped_not_anime_db' : 'skipped_missing_media_db',
					estimatedAniListCost: 1
				});
				continue;
			}

			const estimatedCost = Math.max(
				1,
				Math.ceil(claim.estimatedAniListCost ?? animeSyncJobDefaultCost(claim.jobType))
			);
			const budget = await ctx.runMutation(animeInternal.anime.reserveAniListBudget, {
				now: Date.now(),
				cost: estimatedCost
			});
			if (!(budget as { reserved?: boolean }).reserved) {
				await ctx.runMutation(animeInternal.anime.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: 'retry',
					nextAttemptAt:
						(budget as { nextAllowedAt?: number }).nextAllowedAt ?? Date.now() + 60_000,
					lastError: 'Waiting for AniList quota budget',
					lastResultStatus: 'deferred_quota'
				});
				rateLimited = true;
				break;
			}

			try {
				let result: unknown;
				if (claim.jobType === 'picker') {
					result = await ctx.runAction(api.anime.syncPickerForTMDB, {
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						scheduleTimeline: false
					});
				} else {
					result = await ctx.runAction(api.anime.syncTimelineForTMDB, {
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId
					});
				}

				const rowResult = result as {
					status?: string;
					nodesFetched?: number;
					syncMode?: 'picker' | 'full';
					aniListRequestAttempts?: number;
					aniListRateLimitedResponses?: number;
					aniListRateLimitHints?: {
						limit?: number;
						remaining?: number;
						resetAtMs?: number;
						retryAfterMs?: number;
					};
					animeEligibilityCheck?:
						| 'agree'
						| 'auto_disagree'
						| 'manual_override_disagree'
						| 'db_missing_used_heuristic';
				};
				const heuristicCost = Math.max(
					1,
					Math.min(90, (rowResult.nodesFetched ?? 0) + (claim.jobType === 'picker' ? 2 : 4))
				);
				const learnedCost =
					typeof rowResult.aniListRequestAttempts === 'number' &&
					Number.isFinite(rowResult.aniListRequestAttempts) &&
					rowResult.aniListRequestAttempts > 0
						? Math.max(1, Math.min(90, Math.ceil(rowResult.aniListRequestAttempts)))
						: heuristicCost;
				const reservedCost = Math.max(
					1,
					Math.ceil(claim.estimatedAniListCost ?? animeSyncJobDefaultCost(claim.jobType))
				);
				const overReserved = Math.max(0, reservedCost - learnedCost);
				const refundCapByObserved = Math.floor(
					Math.max(0, learnedCost) * ANIME_BUDGET_REFUND_MAX_OBSERVED_COST_FACTOR
				);
				const refundAmount = Math.min(overReserved, refundCapByObserved);
				if (ANIME_COST_DEBUG_LOGS) {
					console.log('[anime-cost-debug] queue job result', {
						jobType: claim.jobType,
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						status: rowResult.status ?? 'unknown',
						syncMode: rowResult.syncMode ?? null,
						nodesFetched: rowResult.nodesFetched ?? null,
						aniListRequestAttempts: rowResult.aniListRequestAttempts ?? null,
						aniListRateLimitedResponses: rowResult.aniListRateLimitedResponses ?? null,
						aniListRateLimitHints: rowResult.aniListRateLimitHints ?? null,
						estimatedAniListCostPrev: claim.estimatedAniListCost ?? null,
						reservedCost,
						heuristicCost,
						learnedCost,
						overReserved,
						refundAmount
					});
				}
				if (rowResult.aniListRateLimitHints) {
					await ctx.runMutation(animeInternal.anime.recordAniListBudgetHeaders, {
						now: Date.now(),
						limit: rowResult.aniListRateLimitHints.limit,
						remaining: rowResult.aniListRateLimitHints.remaining,
						resetAtMs: rowResult.aniListRateLimitHints.resetAtMs,
						retryAfterMs: rowResult.aniListRateLimitHints.retryAfterMs
					});
				}
				if (refundAmount > 0) {
					const refundResult = await ctx.runMutation(
						animeInternal.anime.refundAniListBudgetReservation,
						{
							now: Date.now(),
							refundAmount
						}
					);
					if (ANIME_COST_DEBUG_LOGS) {
						console.log('[anime-cost-debug] queue job refund', {
							jobType: claim.jobType,
							tmdbType: claim.tmdbType,
							tmdbId: claim.tmdbId,
							refundAmountRequested: refundAmount,
							refundAmountApplied: refundResult?.refunded ?? null,
							tokensAfterRefund: refundResult?.tokens ?? null
						});
					}
				}
				await ctx.runMutation(animeInternal.anime.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: rowResult.status === 'skipped_busy' ? 'retry' : 'success',
					nextAttemptAt: rowResult.status === 'skipped_busy' ? Date.now() + 15_000 : undefined,
					nextRefreshAt:
						rowResult.status === 'skipped_busy'
							? claim.nextRefreshAt
							: Date.now() + computeAnimeQueueRefreshTtlMs(Date.now(), claim.jobType, eligibility),
					lastError: rowResult.status === 'skipped_busy' ? 'Sync busy, retrying' : undefined,
					lastResultStatus: rowResult.status ?? 'unknown',
					animeEligibilityCheck: rowResult.animeEligibilityCheck,
					estimatedAniListCost: learnedCost
				});
				if (ANIME_COST_DEBUG_LOGS) {
					console.log('[anime-cost-debug] queue job persisted', {
						jobType: claim.jobType,
						tmdbType: claim.tmdbType,
						tmdbId: claim.tmdbId,
						estimatedAniListCostNext: learnedCost
					});
				}
				await ctx.runMutation(animeInternal.anime.recordAniListBudgetOutcome, {
					now: Date.now(),
					outcome: 'success'
				});
				processed += 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const isRateLimit = /\b429\b|rate limit|AniList API error 429/i.test(message);
				if (isRateLimit) {
					await ctx.runMutation(animeInternal.anime.recordAniListBudgetOutcome, {
						now: Date.now(),
						outcome: 'rate_limited'
					});
				} else {
					await ctx.runMutation(animeInternal.anime.recordAniListBudgetOutcome, {
						now: Date.now(),
						outcome: 'failure'
					});
				}
				await ctx.runMutation(animeInternal.anime.finishAnimeSyncQueueJob, {
					rowId: claim._id,
					now: Date.now(),
					outcome: 'retry',
					nextAttemptAt:
						Date.now() +
						(isRateLimit
							? 2 * ANIME_SYNC_QUEUE_FAILURE_RETRY_MS
							: ANIME_SYNC_QUEUE_FAILURE_RETRY_MS),
					lastError: message.slice(0, 500),
					lastResultStatus: isRateLimit ? 'rate_limited' : 'failed'
				});
				if (isRateLimit) {
					rateLimited = true;
					break;
				}
			}
		}

		return { processed, rateLimited };
	}
});

export const syncPickerForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		forceNonAnime: v.optional(v.boolean()),
		forceRematch: v.optional(v.boolean()),
		scheduleTimeline: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		const result = await runAnimeSyncWithLease(
			ctx,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				forceNonAnime: args.forceNonAnime,
				forceRematch: args.forceRematch
			},
			{
				jobType: 'picker',
				syncMode: 'picker',
				leaseTtlMs: ANIME_PICKER_SYNC_LEASE_TTL_MS
			}
		);

		const shouldScheduleTimeline =
			args.scheduleTimeline === true && (result as { status?: string }).status === 'synced';
		if (shouldScheduleTimeline) {
			try {
				await ctx.scheduler.runAfter(0, api.anime.syncTimelineForTMDB, {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					forceNonAnime: args.forceNonAnime
				});
			} catch (error) {
				console.warn('[anime] failed to schedule timeline sync after picker sync', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}
		try {
			await ctx.runAction(api.anime.refreshAnimeAlertsForTMDB, {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId
			});
		} catch (error) {
			console.warn('[anime] failed to refresh anime alerts after picker sync', {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				error
			});
		}

		return result;
	}
});

export const syncTimelineForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		forceNonAnime: v.optional(v.boolean()),
		forceRematch: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<unknown> => {
		return await runAnimeSyncWithLease(
			ctx,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				forceNonAnime: args.forceNonAnime,
				forceRematch: args.forceRematch
			},
			{
				jobType: 'timeline',
				syncMode: 'full',
				leaseTtlMs: ANIME_TIMELINE_SYNC_LEASE_TTL_MS
			}
		);
	}
});
