import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx, QueryCtx } from './_generated/server';
import type {
	DisplaySeasonStatus,
	SeasonSourceInput,
	TMDBSeasonEpisodeRow
} from './types/animeEpisodeTypes';
import type { EpisodePoint } from './utils/anime/episodePointUtils';

import { v } from 'convex/values';

import { api, internal } from './_generated/api';
import { action, internalMutation, internalQuery, mutation, query } from './_generated/server';
import {
	buildSeasonEpisodesCachedPayload,
	fetchSeasonEpisodesWithCache,
	getEpisodeCacheRowsFromDB
} from './services/anime/episodeCacheService';
import {
	computeEpisodeDisplayStartFromSeasonRows,
	fetchEpisodesForSeasonSources
} from './services/anime/episodesService';
import {
	computePlanUpdatedAt,
	normalizeDisplaySeasonRowsForWrite,
	normalizeDisplaySeasonSources,
	validateDisplaySeasonPlanRows
} from './services/anime/seasonPlanService';
import { daysSinceDate, parseDateMs } from './utils/anime/dateUtils';
import {
	isSoftClosedLikeStatus,
	resolveDisplayPlanMode,
	tmdbTypeValidator
} from './utils/anime/domain';
import {
	anySourceCoversEpisodePoint,
	compareEpisodePoint,
	episodePointFromTVEpisode
} from './utils/anime/episodePointUtils';
import {
	buildEpisodeBoundsBySeasonFromCacheRows,
	episodeCacheKey,
	loadEpisodeCacheRowsByRequests,
	normalizeSeasonSourcesForEpisodes,
	seasonRequestsForContinuousNumberingRows,
	seasonRequestsForSeasonSources
} from './utils/anime/episodeUtils';
import { getFinalTV } from './utils/mediaLookup';

export const seasonSourceValidator = v.object({
	tmdbType: v.string(),
	tmdbId: v.number(),
	// Stable identifier for a source block within a season row.
	sourceKey: v.string(),
	// Explicit in-row source order. Lower sequence values render first.
	sequence: v.number(),
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

export const seasonNumberingRowValidator = v.object({
	seasonRowKey: v.string(),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	),
	sources: v.array(seasonSourceValidator)
});

export const seasonEpisodesArgs = {
	seasonTitle: v.optional(v.string()),
	sources: v.array(seasonSourceValidator),
	numberingRows: v.optional(v.array(seasonNumberingRowValidator)),
	selectedSeasonRowKey: v.optional(v.string()),
	episodeDisplayStart: v.optional(v.union(v.number(), v.null())),
	episodeNumberingMode: v.optional(
		v.union(v.literal('restarting'), v.literal('continuous'), v.null())
	)
};

type AnimeDisplaySeasonRow = Doc<'animeDisplaySeasons'>;
type AnimeTitleOverrideRow = Doc<'animeTitleOverrides'>;

const displaySeasonSourceInputValidator = v.object({
	// Stable source-block identifier within a season row.
	sourceKey: v.string(),
	// Explicit ordering of source blocks inside a season row. Lower values render first.
	sequence: v.number(),
	tmdbSeasonNumber: v.number(),
	tmdbEpisodeStart: v.union(v.number(), v.null()),
	tmdbEpisodeEnd: v.union(v.number(), v.null()),
	// Applies only to TMDB season 0 (specials). When true, those episodes are
	// treated as regular episodes (E#) instead of SP# labels.
	displayAsRegularEpisode: v.optional(v.boolean())
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

function resolveDefaultEpisodeNumberingMode(
	titleOverride?: AnimeTitleOverrideRow | null
): 'restarting' | 'continuous' {
	return titleOverride?.defaultEpisodeNumberingMode === 'continuous' ? 'continuous' : 'restarting';
}

function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function syntheticSeasonRowStableSeasonId(
	tmdbType: 'movie' | 'tv',
	tmdbId: number,
	rowKey: string
): number {
	const hashed = fnv1a32(`${tmdbType}:${tmdbId}:${rowKey}`);
	const value = 1 + (hashed % 2_000_000_000);
	return -value;
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

function isSpecialOnlySeasonRow(row: {
	seasonSources?: Array<{ tmdbSeasonNumber?: number | null }> | null;
	seasonXref?: { tmdbSeasonNumber?: number | null } | null;
}): boolean {
	const sources = row.seasonSources ?? [];
	if (sources.length > 0) {
		return sources.every((source) => (source.tmdbSeasonNumber ?? null) === 0);
	}
	return (row.seasonXref?.tmdbSeasonNumber ?? null) === 0;
}

function computeDisplaySeasonCountFromSeasonRows(
	rows: Array<{
		stableSeasonId: number;
		memberAnilistIds?: number[] | null;
		seasonSources?: Array<{ tmdbSeasonNumber?: number | null }> | null;
		seasonXref?: { tmdbSeasonNumber?: number | null } | null;
	}>,
	mode: 'anilist' | 'tmdb_seasons' = 'anilist'
): number | null {
	if (mode === 'tmdb_seasons') {
		let count = 0;
		for (const row of rows) {
			if (isSpecialOnlySeasonRow(row)) continue;
			count += 1;
		}
		return count > 0 ? count : null;
	}
	const seasonKeys = new Set<string>();
	for (const row of rows) {
		if (isSpecialOnlySeasonRow(row)) continue;
		const memberIds = (row.memberAnilistIds ?? []).slice().sort((a, b) => a - b);
		if (memberIds.length > 0) {
			seasonKeys.add(`members:${memberIds.join(',')}`);
			continue;
		}
		seasonKeys.add(`stable:${row.stableSeasonId}`);
	}
	return seasonKeys.size > 0 ? seasonKeys.size : null;
}

function estimateSeasonRowEpisodeCount(row: {
	media?: { episodes?: number | null } | null;
	seasonSources?: Array<{
		tmdbSeasonNumber?: number | null;
		tmdbEpisodeStart?: number | null;
		tmdbEpisodeEnd?: number | null;
	}> | null;
}): number | null {
	const sources = row.seasonSources ?? [];
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

function applyEpisodeDisplayStartsToSeasonRows<
	T extends {
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		media?: { episodes?: number | null } | null;
		seasonSources?: Array<{
			tmdbSeasonNumber?: number | null;
			tmdbEpisodeStart?: number | null;
			tmdbEpisodeEnd?: number | null;
		}> | null;
	}
>(rows: T[]): Array<T & { episodeDisplayStart: number | null }> {
	let continuousCounter = 1;
	let canResolveContinuousCounter = true;
	return rows.map((row) => {
		const isSpecialOnly = isSpecialOnlySeasonRow(row);
		const mode = row.episodeNumberingMode ?? 'restarting';
		let episodeDisplayStart: number | null = null;
		if (!isSpecialOnly) {
			if (mode === 'continuous') {
				episodeDisplayStart = canResolveContinuousCounter ? continuousCounter : null;
			} else {
				episodeDisplayStart = 1;
			}
		}
		const estimatedCount = estimateSeasonRowEpisodeCount(row);
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

type EpisodeNumberingMode = 'restarting' | 'continuous' | null;

type SeasonNumberingRow = {
	seasonRowKey: string;
	episodeNumberingMode?: EpisodeNumberingMode;
	sources: SeasonSourceInput[];
};

type SeasonEpisodesHandlerArgs = {
	seasonTitle?: string;
	sources: SeasonSourceInput[];
	numberingRows?: SeasonNumberingRow[];
	selectedSeasonRowKey?: string;
	episodeDisplayStart?: number | null;
	episodeNumberingMode?: EpisodeNumberingMode;
};

async function getSeasonEpisodesHandler(ctx: ActionCtx, args: SeasonEpisodesHandlerArgs) {
	const normalizedSources = normalizeSeasonSourcesForEpisodes(args.sources);
	const seasonRequests = seasonRequestsForSeasonSources(normalizedSources);
	const episodeSeasonCache = await fetchSeasonEpisodesWithCache(ctx, seasonRequests);
	let computedEpisodeDisplayStart: number | null = null;
	if (
		(args.episodeNumberingMode ?? null) === 'continuous' &&
		args.numberingRows &&
		args.selectedSeasonRowKey
	) {
		computedEpisodeDisplayStart = await computeEpisodeDisplayStartFromSeasonRows(
			args.numberingRows.map((row) => ({
				seasonRowKey: row.seasonRowKey,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				sources: row.sources
			})),
			args.selectedSeasonRowKey,
			episodeSeasonCache,
			true
		);
	}
	const episodes = await fetchEpisodesForSeasonSources(normalizedSources, episodeSeasonCache, {
		episodeDisplayStart: computedEpisodeDisplayStart ?? args.episodeDisplayStart ?? null,
		episodeNumberingMode: args.episodeNumberingMode ?? null
	});
	return {
		seasonTitle: args.seasonTitle ?? null,
		episodes,
		cacheStatus: seasonRequests.length === 0 ? 'fresh' : 'fresh',
		hasMissingSeasons: false,
		hasStaleSeasons: false,
		missingSeasonCount: 0,
		staleSeasonCount: 0,
		totalSeasonCount: seasonRequests.length
	};
}

async function getSeasonEpisodesCachedHandler(ctx: QueryCtx, args: SeasonEpisodesHandlerArgs) {
	const normalizedSources = normalizeSeasonSourcesForEpisodes(args.sources);
	const seasonRequests = seasonRequestsForSeasonSources(normalizedSources);
	const cacheRows = await getEpisodeCacheRowsFromDB(ctx, seasonRequests);
	const payload = buildSeasonEpisodesCachedPayload({
		seasonTitle: args.seasonTitle,
		seasonRequests,
		cacheRows
	});
	let computedEpisodeDisplayStart: number | null = null;
	if (
		(args.episodeNumberingMode ?? null) === 'continuous' &&
		args.numberingRows &&
		args.selectedSeasonRowKey
	) {
		const numberingRows = args.numberingRows.map((row) => ({
			seasonRowKey: row.seasonRowKey,
			episodeNumberingMode: row.episodeNumberingMode ?? null,
			sources: row.sources
		}));
		const numberingSeasonRequests = seasonRequestsForContinuousNumberingRows(
			numberingRows,
			args.selectedSeasonRowKey
		);
		const numberingCacheRows = await getEpisodeCacheRowsFromDB(ctx, numberingSeasonRequests);
		const numberingSeasonCache = new Map(payload.episodeSeasonCache);
		for (const row of numberingCacheRows) {
			numberingSeasonCache.set(
				episodeCacheKey(row.tmdbId, row.seasonNumber),
				row.episodes as TMDBSeasonEpisodeRow[]
			);
		}
		computedEpisodeDisplayStart = await computeEpisodeDisplayStartFromSeasonRows(
			numberingRows,
			args.selectedSeasonRowKey,
			numberingSeasonCache,
			false
		);
	}
	const episodes = await fetchEpisodesForSeasonSources(
		normalizedSources,
		payload.episodeSeasonCache,
		{
			allowNetworkFetch: false,
			episodeDisplayStart: computedEpisodeDisplayStart ?? args.episodeDisplayStart ?? null,
			episodeNumberingMode: args.episodeNumberingMode ?? null
		}
	);
	return {
		seasonTitle: payload.seasonTitle,
		episodes,
		cacheStatus: payload.cacheStatus,
		hasMissingSeasons: payload.hasMissingSeasons,
		hasStaleSeasons: payload.hasStaleSeasons,
		missingSeasonCount: payload.missingSeasonCount,
		staleSeasonCount: payload.staleSeasonCount,
		totalSeasonCount: payload.totalSeasonCount
	};
}

async function refreshSeasonEpisodesCacheHandler(ctx: ActionCtx, args: SeasonEpisodesHandlerArgs) {
	const normalizedSources = normalizeSeasonSourcesForEpisodes(args.sources);
	const seasonRequests = seasonRequestsForSeasonSources(normalizedSources);
	let refreshRequests = seasonRequests;
	if (
		(args.episodeNumberingMode ?? null) === 'continuous' &&
		args.numberingRows &&
		args.selectedSeasonRowKey
	) {
		refreshRequests = seasonRequestsForContinuousNumberingRows(
			args.numberingRows.map((row) => ({
				seasonRowKey: row.seasonRowKey,
				episodeNumberingMode: row.episodeNumberingMode ?? null,
				sources: row.sources
			})),
			args.selectedSeasonRowKey
		);
	}
	await fetchSeasonEpisodesWithCache(ctx, refreshRequests);
	const tmdbIds = new Set(refreshRequests.map((request) => request.tmdbId));
	for (const tmdbId of tmdbIds) {
		try {
			await ctx.runAction(api.animeAlerts.refreshAnimeAlertsForTMDB, {
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
		return await loadEpisodeCacheRowsByRequests(ctx.db, args.requests);
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
			const normalizedSources = normalizeDisplaySeasonSources(
				row.sources as AnimeDisplaySeasonRow['sources']
			);
			if (
				nextStatus !== 'closed' &&
				row.seasonOrdinal != null &&
				latestMainOrdinal != null &&
				(boundsBySeason.get(row.seasonOrdinal) != null ||
					normalizedSources.some((source) => boundsBySeason.get(source.tmdbSeasonNumber) != null))
			) {
				if (row.seasonOrdinal < latestMainOrdinal || isEndedSeries) {
					nextStatus = 'closed';
					changed = true;
				}
			}
			const nextSources = normalizedSources.map((source) => {
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
					sourceKey: source.sourceKey,
					sequence: source.sequence,
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

export const updateAnimeSeasons: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		rows: v.array(displaySeasonRowUpdateInputValidator),
		expectedPlanUpdatedAt: v.optional(v.union(v.number(), v.null()))
	},
	handler: async (ctx, args): Promise<unknown> => {
		const existingRows = (await ctx.runQuery(api.animeSeasons.getDisplaySeasonPlan, {
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
					sourceKey: string;
					sequence: number;
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
				sourceKey: string;
				sequence: number;
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
				sourceKey: source.sourceKey.trim(),
				sequence: source.sequence,
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
					sourceKey: source.sourceKey.trim(),
					sequence: source.sequence,
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

		const result = await ctx.runMutation(internal.animeSeasons.replaceDisplaySeasonPlan, {
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
			await ctx.runAction(api.animeAlerts.refreshAnimeAlertsForTMDB, {
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

export const resetAnimeSeasonsToAuto: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const existingRows = await ctx.runQuery(api.animeSeasons.getDisplaySeasonPlan, args);
		await ctx.runMutation(internal.animeSeasons.replaceDisplaySeasonPlan, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			rows: [],
			expectedPlanUpdatedAt: (existingRows as { planUpdatedAt?: number }).planUpdatedAt ?? 0
		});
		await ctx.runMutation(api.animeSeasons.setAnimeDisplayTitleOverrides, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			displayPlanMode: 'auto'
		});
		const syncResult = await ctx.runAction(api.animeSync.syncSeasonForTMDB, {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			scheduleTimeline: false
		});
		return { ok: true, removedRows: existingRows.rows.length, syncResult };
	}
});

// Derived safety/attention report for anime display-season plans.
// This query does not write DB flags; it computes warnings from display rows + cache coverage.
export const listAnimeSeasonReport = query({
	args: {
		maxTitles: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const maxTitles = Math.max(1, Math.min(args.maxTitles ?? 100, 500));
		const rowsByTitle = new Map<string, AnimeDisplaySeasonRow[]>();
		let cursor: string | null = null;
		let done = false;
		while (!done && rowsByTitle.size < maxTitles) {
			const page = await ctx.db.query('animeDisplaySeasons').order('asc').paginate({
				numItems: 500,
				cursor
			});
			for (const row of page.page) {
				if (row.tmdbType !== 'tv' || row.hidden === true) continue;
				const key = `${row.tmdbType}:${row.tmdbId}`;
				const list = rowsByTitle.get(key);
				if (list) {
					list.push(row);
					continue;
				}
				if (rowsByTitle.size >= maxTitles) continue;
				rowsByTitle.set(key, [row]);
			}
			done = page.isDone;
			cursor = page.continueCursor;
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

		const titleRows = Array.from(rowsByTitle.values()).slice(0, maxTitles);
		const cacheRowsByTmdbId = new Map<number, Array<Doc<'animeEpisodeCache'>>>();
		const cachePrefetchBatchSize = 12;
		for (let index = 0; index < titleRows.length; index += cachePrefetchBatchSize) {
			const batch = titleRows.slice(index, index + cachePrefetchBatchSize);
			const prefetched = await Promise.all(
				batch.map(async (rows) => {
					const tmdbId = Number(rows[0]?.tmdbId);
					if (!Number.isFinite(tmdbId)) {
						return { tmdbId: NaN, cacheRows: [] as Array<Doc<'animeEpisodeCache'>> };
					}
					const cacheRows = await ctx.db
						.query('animeEpisodeCache')
						.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', tmdbId))
						.collect();
					return { tmdbId, cacheRows };
				})
			);
			for (const entry of prefetched) {
				if (!Number.isFinite(entry.tmdbId)) continue;
				cacheRowsByTmdbId.set(entry.tmdbId, entry.cacheRows);
			}
		}

		for (const rows of titleRows) {
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
			const cacheRows = cacheRowsByTmdbId.get(tmdbId) ?? [];
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
					sourceKey: source.sourceKey,
					sequence: source.sequence,
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
					sourceKey: source.sourceKey,
					sequence: source.sequence,
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
					sourceKey: `${rowKey}:source:1`,
					sequence: 1,
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
					sourceKey: `${rowKey}:source:1`,
					sequence: 1,
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

		const seasonRowsBase = (args.tmdbType === 'tv' ? displayRows : [])
			.filter((row) => row.hidden !== true)
			.slice()
			.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.rowKey.localeCompare(b.rowKey))
			.map((row) => {
				const sources = normalizeDisplaySeasonSources(
					row.sources as AnimeDisplaySeasonRow['sources']
				).map((source) => ({
					tmdbType: 'tv',
					tmdbId: args.tmdbId,
					sourceKey: source.sourceKey,
					sequence: source.sequence,
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
				const syntheticId = syntheticSeasonRowStableSeasonId(
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
						studios: []
					},
					seasonXref:
						sources[0] == null
							? null
							: {
									tmdbType: 'tv',
									tmdbId: args.tmdbId,
									sourceKey: sources[0].sourceKey,
									sequence: sources[0].sequence,
									tmdbSeasonNumber: sources[0].tmdbSeasonNumber ?? null,
									tmdbSeasonName: row.label,
									tmdbEpisodeStart: sources[0].tmdbEpisodeStart ?? null,
									tmdbEpisodeEnd: sources[0].tmdbEpisodeEnd ?? null,
									confidence: 1,
									method: row.sourceMode,
									locked: row.locked ?? false
								},
					seasonGroupKey: `display:${row.rowKey}`,
					seasonTitle: row.label,
					seasonOrdinal: row.seasonOrdinal ?? null,
					episodeNumberingMode: rowEpisodeNumberingMode,
					memberAnilistIds: xref?.anilistId != null ? [xref.anilistId] : [],
					seasonSources: sources
				};
			});
		const seasons = applyEpisodeDisplayStartsToSeasonRows(seasonRowsBase);
		const selectedSeason =
			seasons.find((item) => item.stableSeasonId === args.selectedStableSeasonId) ??
			seasons[0] ??
			null;
		const computedDisplaySeasonCount = computeDisplaySeasonCountFromSeasonRows(
			seasons,
			'tmdb_seasons'
		);
		const explicitDisplaySeasonCount = titleOverride?.displaySeasonCountOverride ?? null;
		return {
			seasons,
			displaySeasonCount: explicitDisplaySeasonCount ?? computedDisplaySeasonCount,
			selectedSeason
		};
	}
});

export const getSeasonEpisodes = action({
	args: seasonEpisodesArgs,
	handler: getSeasonEpisodesHandler
});

export const getSeasonEpisodesCached = query({
	args: seasonEpisodesArgs,
	handler: getSeasonEpisodesCachedHandler
});

export const refreshSeasonEpisodesCache = action({
	args: seasonEpisodesArgs,
	handler: refreshSeasonEpisodesCacheHandler
});
