import type { Id } from '../../_generated/dataModel';
import type { DisplaySeasonStatus } from '../../types/animeEpisodeTypes';

import { isSoftClosedLikeStatus } from '../../utils/anime/domain';

export function normalizeDisplaySeasonSources(
	sources: Array<{
		tmdbSeasonNumber: number;
		tmdbEpisodeStart?: number | null;
		tmdbEpisodeEnd?: number | null;
		displayAsRegularEpisode?: boolean;
	}>
): Array<{
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

export function validateDisplaySeasonPlanRows(
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

export function normalizeDisplaySeasonRowsForWrite<
	TRow extends {
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
		rowId?: Id<'animeDisplaySeasons'> | null;
	}
>(rows: TRow[]) {
	return rows.map((row) => ({
		...(row.rowId !== undefined ? { rowId: row.rowId ?? null } : {}),
		rowKey: row.rowKey.trim(),
		label: row.label.trim() || row.rowKey.trim(),
		sortOrder: row.sortOrder,
		rowType: row.rowType,
		seasonOrdinal: row.seasonOrdinal ?? null,
		episodeNumberingMode: row.episodeNumberingMode ?? null,
		status: row.status ?? null,
		hidden: row.hidden ?? false,
		locked: row.locked ?? false,
		sources: normalizeDisplaySeasonSources(row.sources)
	}));
}

export function computePlanUpdatedAt(rows: Array<{ updatedAt?: number }>): number {
	if (rows.length === 0) return 0;
	let max = 0;
	for (const row of rows) {
		const value = row.updatedAt ?? 0;
		if (value > max) max = value;
	}
	return max;
}
