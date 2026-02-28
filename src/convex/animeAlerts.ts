import type { Id } from './_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import type { DisplaySeasonStatus } from './types/animeEpisodeTypes';
import type { EpisodePoint } from './utils/anime/episodePointUtils';

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
import { normalizeDisplaySeasonSources } from './services/anime/seasonPlanService';
import { daysSinceDate } from './utils/anime/dateUtils';
import { isSoftClosedLikeStatus, tmdbTypeValidator } from './utils/anime/domain';
import {
	anySourceCoversEpisodePoint,
	episodePointFromTVEpisode
} from './utils/anime/episodePointUtils';
import {
	animeSyncQueueKey,
	animeTitleSyncLeaseKey,
	createAnimeSyncLeaseOwner
} from './utils/anime/sync';
import { getFinalTV } from './utils/mediaLookup';

const ANIME_ALERT_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const animeSeedTableValidator = v.union(v.literal('tvShows'), v.literal('movies'));

export const animeAlertScopeTypeValidator = v.union(
	v.literal('title'),
	v.literal('display_row'),
	v.literal('tmdb_season'),
	v.literal('xref')
);
export const animeAlertSeverityValidator = v.union(
	v.literal('info'),
	v.literal('warning'),
	v.literal('error')
);
export const animeAlertStatusValidator = v.union(
	v.literal('open'),
	v.literal('acknowledged'),
	v.literal('resolved')
);
export const animeAlertSourceValidator = v.union(
	v.literal('season_report'),
	v.literal('needs_review')
);

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

export const animeAlertDraftValidator = v.object({
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

function animeAlertFingerprint(parts: Array<string | number | null | undefined>): string {
	return parts.map((part) => (part == null ? 'none' : String(part))).join(':');
}

async function getAnimeSeasonReportForTMDBHandler(
	ctx: QueryCtx,
	args: { tmdbType: 'movie' | 'tv'; tmdbId: number }
) {
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
		sources: normalizeDisplaySeasonSources(
			row.sources as Array<{
				sourceKey: string;
				sequence: number;
				tmdbSeasonNumber: number;
				tmdbEpisodeStart?: number | null;
				tmdbEpisodeEnd?: number | null;
				displayAsRegularEpisode?: boolean;
			}>
		)
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

async function getAnimeNeedsReviewSignalsForTMDBHandler(
	ctx: QueryCtx,
	args: { tmdbType: 'movie' | 'tv'; tmdbId: number; xrefThreshold?: number }
) {
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
			q.eq('syncKey', animeSyncQueueKey('season', args.tmdbType, args.tmdbId))
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

async function replaceAnimeAlertsForTMDBHandler(
	ctx: MutationCtx,
	args: {
		tmdbType: 'movie' | 'tv';
		tmdbId: number;
		alerts: AnimeAlertDraft[];
	}
) {
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

async function refreshAnimeAlertsForTMDBHandler(
	ctx: ActionCtx,
	args: { tmdbType: 'movie' | 'tv'; tmdbId: number }
) {
	const autoSoftCloseResult = (await ctx.runMutation(
		internal.animeSeasons.autoSoftCloseAnimeSeasonsForTMDB,
		args
	)) as {
		ok: boolean;
		updated: number;
		rowKeys: string[];
		blockedRowKeys: string[];
	};
	const autoCreateLeaseOwner = createAnimeSyncLeaseOwner();
	const autoCreateLease = (await ctx.runMutation(internal.animeSync.tryAcquireAnimeLease, {
		leaseKey: animeTitleSyncLeaseKey('season', args.tmdbType, args.tmdbId) + ':auto_create_season',
		leaseKind: 'title_sync',
		jobType: 'season',
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
				internal.animeSeasons.autoCreateNextAnimeSeasonForTMDB,
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
			await ctx.runMutation(internal.animeSync.releaseAnimeLease, {
				leaseId: autoCreateLease.leaseId,
				owner: autoCreateLeaseOwner
			});
		}
	}
	const seasonReport = (await ctx.runQuery(
		internal.animeAlerts.getAnimeSeasonReportForTMDB,
		args
	)) as {
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
		internal.animeAlerts.getAnimeNeedsReviewSignalsForTMDB,
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

	await ctx.runMutation(internal.animeAlerts.replaceAnimeAlertsForTMDB, {
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId,
		alerts
	});
	return { ok: true, alerts: alerts.length };
}

async function listAnimeAlertsHandler(
	ctx: QueryCtx,
	args: {
		status?: 'open' | 'acknowledged' | 'resolved';
		maxItems?: number;
	}
) {
	const maxItems = Math.max(1, Math.min(args.maxItems ?? 200, 500));
	const rows = args.status
		? await ctx.db
				.query('animeAlerts')
				.withIndex('by_status_lastSeenAt', (q) => q.eq('status', args.status!))
				.order('desc')
				.take(maxItems)
		: (
				await Promise.all(
					(['open', 'acknowledged', 'resolved'] as const).map((status) =>
						ctx.db
							.query('animeAlerts')
							.withIndex('by_status_lastSeenAt', (q) => q.eq('status', status))
							.order('desc')
							.take(maxItems)
					)
				)
			)
				.flat()
				.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
				.slice(0, maxItems);
	const items = rows.map((row) => ({
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

async function setAnimeAlertStatusHandler(
	ctx: MutationCtx,
	args: { alertId: Id<'animeAlerts'>; status: 'acknowledged' | 'resolved' | 'open' }
) {
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

async function getAnimeAlertSweepStateHandler(
	ctx: QueryCtx,
	args: { table: 'tvShows' | 'movies' }
) {
	const rows = await ctx.db
		.query('animeAlertSweepState')
		.withIndex('by_table', (q) => q.eq('table', args.table))
		.collect();
	return rows[0] ?? null;
}

async function upsertAnimeAlertSweepStateHandler(
	ctx: MutationCtx,
	args: { table: 'tvShows' | 'movies'; cursor?: string | null; lastRunAt?: number | null }
) {
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

type AnimeQueueSeedCandidate = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
};

async function sweepAnimeAlertsMaterializedHandler(
	ctx: ActionCtx,
	args: { table?: 'tvShows' | 'movies'; limitPerTable?: number }
) {
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
		const sweepState = (await ctx.runQuery(internal.animeAlerts.getAnimeAlertSweepState, {
			table
		})) as { cursor?: string | null } | null;
		const page = (await ctx.runQuery(internal.animeSync.getAnimeQueueSeedCandidatesPage, {
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
		const batchSize = 8;
		for (let index = 0; index < page.candidates.length; index += batchSize) {
			const batch = page.candidates.slice(index, index + batchSize);
			const outcomes = await Promise.all(
				batch.map(async (candidate) => {
					try {
						await ctx.runAction(api.animeAlerts.refreshAnimeAlertsForTMDB, {
							tmdbType: candidate.tmdbType,
							tmdbId: candidate.tmdbId
						});
						return 1;
					} catch (error) {
						console.warn('[anime] failed to materialize alerts during cron sweep', {
							table,
							tmdbType: candidate.tmdbType,
							tmdbId: candidate.tmdbId,
							error
						});
						return 0;
					}
				})
			);
			let batchProcessed = 0;
			for (const outcome of outcomes) {
				batchProcessed += outcome;
			}
			processed += batchProcessed;
		}

		await ctx.runMutation(internal.animeAlerts.upsertAnimeAlertSweepState, {
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

export const getAnimeSeasonReportForTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: getAnimeSeasonReportForTMDBHandler
});

export const getAnimeNeedsReviewSignalsForTMDB = internalQuery({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		xrefThreshold: v.optional(v.number())
	},
	handler: getAnimeNeedsReviewSignalsForTMDBHandler
});

export const replaceAnimeAlertsForTMDB = internalMutation({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number(),
		alerts: v.array(animeAlertDraftValidator)
	},
	handler: replaceAnimeAlertsForTMDBHandler
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

export const refreshAnimeAlertsForTMDB: ReturnType<typeof action> = action({
	args: {
		tmdbType: tmdbTypeValidator,
		tmdbId: v.number()
	},
	handler: refreshAnimeAlertsForTMDBHandler
});

export const listAnimeAlerts = query({
	args: {
		status: v.optional(animeAlertStatusValidator),
		maxItems: v.optional(v.number())
	},
	handler: listAnimeAlertsHandler
});

export const setAnimeAlertStatus = mutation({
	args: {
		alertId: v.id('animeAlerts'),
		status: v.union(v.literal('acknowledged'), v.literal('resolved'), v.literal('open'))
	},
	handler: setAnimeAlertStatusHandler
});

export const getAnimeAlertSweepState = internalQuery({
	args: {
		table: animeSeedTableValidator
	},
	handler: getAnimeAlertSweepStateHandler
});

export const upsertAnimeAlertSweepState = internalMutation({
	args: {
		table: animeSeedTableValidator,
		cursor: v.optional(v.union(v.string(), v.null())),
		lastRunAt: v.optional(v.union(v.number(), v.null()))
	},
	handler: upsertAnimeAlertSweepStateHandler
});

export const sweepAnimeAlertsMaterialized = internalAction({
	args: {
		table: v.optional(animeSeedTableValidator),
		limitPerTable: v.optional(v.number())
	},
	handler: sweepAnimeAlertsMaterializedHandler
});
