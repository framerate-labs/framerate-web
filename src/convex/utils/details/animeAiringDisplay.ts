import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { StoredEpisodeSummary } from '../../types/detailsType';

import { normalizeDisplaySeasonSources } from '../../services/anime/seasonPlanService';

type AnimeDisplaySeasonRow = Doc<'animeDisplaySeasons'>;
type AnimeTitleOverrideRow = Doc<'animeTitleOverrides'>;

type DisplaySeasonSource = {
	tmdbSeasonNumber: number;
	tmdbEpisodeStart: number | null;
	tmdbEpisodeEnd: number | null;
	displayAsRegularEpisode?: boolean;
};

type DisplaySeasonRow = {
	rowKey: string;
	orderIndex: number;
	isMainline: boolean;
	seasonOrdinal: number | null;
	episodeNumberingMode: 'restarting' | 'continuous';
	episodeDisplayStart: number | null;
	sources: DisplaySeasonSource[];
};

type EpisodePoint = {
	season: number;
	episode: number;
};

export type AnimeMappedAiringEpisode = {
	displaySeasonNumber: number | null;
	displayEpisodeNumber: number | null;
};

type AnimeAiringDisplayContext = {
	rows: DisplaySeasonRow[];
};

function resolveDefaultEpisodeNumberingMode(
	titleOverride?: AnimeTitleOverrideRow | null
): 'restarting' | 'continuous' {
	return titleOverride?.defaultEpisodeNumberingMode === 'continuous' ? 'continuous' : 'restarting';
}

function isSpecialOnlyRow(row: Pick<DisplaySeasonRow, 'sources'>): boolean {
	return row.sources.length > 0 && row.sources.every((source) => source.tmdbSeasonNumber === 0);
}

function estimateSeasonRowEpisodeCount(row: Pick<DisplaySeasonRow, 'sources'>): number | null {
	const nonSpecialSources = row.sources.filter((source) => source.tmdbSeasonNumber !== 0);
	if (nonSpecialSources.length > 0) {
		let total = 0;
		for (const source of nonSpecialSources) {
			const start = source.tmdbEpisodeStart;
			const end = source.tmdbEpisodeEnd;
			if (start == null || end == null || end < start) return null;
			total += end - start + 1;
		}
		return total;
	}
	return null;
}

function applyEpisodeDisplayStartsToRows(rows: DisplaySeasonRow[]): DisplaySeasonRow[] {
	let continuousCounter = 1;
	let canResolveContinuousCounter = true;

	return rows.map((row) => {
		const isSpecialOnly = isSpecialOnlyRow(row);
		let episodeDisplayStart: number | null = null;

		if (!isSpecialOnly) {
			episodeDisplayStart =
				row.episodeNumberingMode === 'continuous'
					? canResolveContinuousCounter
						? continuousCounter
						: null
					: 1;
		}

		const estimatedCount = estimateSeasonRowEpisodeCount(row);
		if (!isSpecialOnly && row.episodeNumberingMode === 'continuous') {
			if (estimatedCount != null && estimatedCount > 0 && canResolveContinuousCounter) {
				continuousCounter += estimatedCount;
			} else if (estimatedCount == null) {
				canResolveContinuousCounter = false;
			}
		}

		return {
			...row,
			episodeDisplayStart
		};
	});
}

function sourceContainsEpisodePoint(source: DisplaySeasonSource, point: EpisodePoint): boolean {
	if (source.tmdbSeasonNumber !== point.season) return false;
	const start = source.tmdbEpisodeStart ?? 1;
	const end = source.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER;
	return point.episode >= start && point.episode <= end;
}

function rowContainsTMDBSeason(row: DisplaySeasonRow, tmdbSeasonNumber: number): boolean {
	return row.sources.some((source) => source.tmdbSeasonNumber === tmdbSeasonNumber);
}

function rowHasOpenEndedSource(row: DisplaySeasonRow, tmdbSeasonNumber: number): boolean {
	return row.sources.some((source) => {
		return source.tmdbSeasonNumber === tmdbSeasonNumber && source.tmdbEpisodeEnd == null;
	});
}

function boundedEpisodeCount(source: DisplaySeasonSource): number | null {
	const start = source.tmdbEpisodeStart ?? 1;
	const end = source.tmdbEpisodeEnd;
	if (end == null || end < start) return null;
	return end - start + 1;
}

function cumulativeEpisodeOffset(
	sources: DisplaySeasonSource[],
	beforeIndex: number
): number | null {
	if (beforeIndex <= 0) return 0;

	let offset = 0;
	for (let index = 0; index < beforeIndex; index += 1) {
		const count = boundedEpisodeCount(sources[index]);
		if (count == null) return null;
		offset += count;
	}
	return offset;
}

function sortedSourcesForDisplayMath(sources: DisplaySeasonSource[]): DisplaySeasonSource[] {
	return sources.slice().sort((left, right) => {
		const leftSeason = left.tmdbSeasonNumber;
		const rightSeason = right.tmdbSeasonNumber;
		if (leftSeason !== rightSeason) return leftSeason - rightSeason;
		const leftStart = left.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
		const rightStart = right.tmdbEpisodeStart ?? Number.MAX_SAFE_INTEGER;
		if (leftStart !== rightStart) return leftStart - rightStart;
		return (
			(left.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER) -
			(right.tmdbEpisodeEnd ?? Number.MAX_SAFE_INTEGER)
		);
	});
}

function compareRowsAscending(left: DisplaySeasonRow, right: DisplaySeasonRow): number {
	if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
	const leftOrdinal = left.seasonOrdinal ?? Number.MAX_SAFE_INTEGER;
	const rightOrdinal = right.seasonOrdinal ?? Number.MAX_SAFE_INTEGER;
	if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
	return left.rowKey.localeCompare(right.rowKey);
}

function comparePersistedRowsAscending(
	left: Pick<AnimeDisplaySeasonRow, 'rowKey' | 'sortOrder' | 'seasonOrdinal'>,
	right: Pick<AnimeDisplaySeasonRow, 'rowKey' | 'sortOrder' | 'seasonOrdinal'>
): number {
	return compareRowsAscending(
		{
			rowKey: left.rowKey,
			orderIndex: left.sortOrder ?? 0,
			isMainline: true,
			seasonOrdinal: left.seasonOrdinal ?? null,
			episodeNumberingMode: 'restarting',
			episodeDisplayStart: null,
			sources: []
		},
		{
			rowKey: right.rowKey,
			orderIndex: right.sortOrder ?? 0,
			isMainline: true,
			seasonOrdinal: right.seasonOrdinal ?? null,
			episodeNumberingMode: 'restarting',
			episodeDisplayStart: null,
			sources: []
		}
	);
}

function displaySeasonNumber(row: DisplaySeasonRow, rows: DisplaySeasonRow[]): number | null {
	const visibleMainlineRows = rows.filter((candidate) => candidate.isMainline);
	const index = visibleMainlineRows.findIndex((candidate) => candidate.rowKey == row.rowKey);
	if (index >= 0) return index + 1;
	return row.seasonOrdinal;
}

function matchedDisplayRow(
	point: EpisodePoint,
	rows: DisplaySeasonRow[],
	prefersLatestOpenEndedRow: boolean
): DisplaySeasonRow | null {
	const candidates = rows.filter(
		(row) => row.isMainline && rowContainsTMDBSeason(row, point.season)
	);
	if (candidates.length === 0) return null;

	if (prefersLatestOpenEndedRow) {
		const openEndedCandidates = candidates.filter((row) =>
			rowHasOpenEndedSource(row, point.season)
		);
		if (openEndedCandidates.length > 0) {
			const sorted = openEndedCandidates.slice().sort(compareRowsAscending);
			return sorted[sorted.length - 1] ?? null;
		}
	}

	const exactRow = candidates.find((row) =>
		row.sources.some((source) => sourceContainsEpisodePoint(source, point))
	);
	if (exactRow) return exactRow;

	const sortedCandidates = candidates.slice().sort(compareRowsAscending);
	return sortedCandidates[sortedCandidates.length - 1] ?? null;
}

export async function loadAnimeAiringDisplayContext(
	ctx: QueryCtx,
	args: { tmdbType: 'tv' | 'movie'; tmdbId: number }
): Promise<AnimeAiringDisplayContext | null> {
	const [displayRows, titleOverrideRows] = await Promise.all([
		ctx.db
			.query('animeDisplaySeasons')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect(),
		ctx.db
			.query('animeTitleOverrides')
			.withIndex('by_tmdb', (q) => q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId))
			.collect()
	]);

	if (displayRows.length === 0) return null;

	const titleOverride = titleOverrideRows[0] ?? null;
	const defaultEpisodeNumberingMode = resolveDefaultEpisodeNumberingMode(titleOverride);

	const rowsBase = displayRows
		.filter((row) => row.hidden !== true)
		.slice()
		.sort(comparePersistedRowsAscending)
		.map((row) => ({
			rowKey: row.rowKey,
			orderIndex: row.sortOrder ?? 0,
			isMainline: row.rowType !== 'specials',
			seasonOrdinal: row.seasonOrdinal ?? null,
			episodeNumberingMode:
				(row.episodeNumberingMode ?? defaultEpisodeNumberingMode) === 'continuous'
					? 'continuous'
					: 'restarting',
			episodeDisplayStart: null,
			sources: normalizeDisplaySeasonSources(row.sources).map((source) => ({
				tmdbSeasonNumber: source.tmdbSeasonNumber,
				tmdbEpisodeStart: source.tmdbEpisodeStart ?? null,
				tmdbEpisodeEnd: source.tmdbEpisodeEnd ?? null,
				displayAsRegularEpisode: source.displayAsRegularEpisode
			}))
		}));

	return {
		rows: applyEpisodeDisplayStartsToRows(rowsBase)
	};
}

export function mapAnimeAiringEpisodeToDisplay(
	context: AnimeAiringDisplayContext | null,
	episode: StoredEpisodeSummary | null | undefined,
	options?: { prefersLatestOpenEndedRow?: boolean }
): AnimeMappedAiringEpisode | null {
	if (!context || !episode) return null;
	if (episode.episodeNumber <= 0) return null;

	const point: EpisodePoint = {
		season: episode.seasonNumber,
		episode: episode.episodeNumber
	};
	const row = matchedDisplayRow(point, context.rows, options?.prefersLatestOpenEndedRow === true);
	if (!row) return null;

	const resolvedDisplaySeasonNumber = displaySeasonNumber(row, context.rows);
	if (resolvedDisplaySeasonNumber == null || resolvedDisplaySeasonNumber <= 0) {
		return null;
	}

	const sortedSources = sortedSourcesForDisplayMath(row.sources);
	const exactSourceIndex = sortedSources.findIndex((source) =>
		sourceContainsEpisodePoint(source, point)
	);
	const matchingSourceIndex =
		exactSourceIndex >= 0
			? exactSourceIndex
			: sortedSources.findIndex((source) => source.tmdbSeasonNumber === point.season);

	if (matchingSourceIndex < 0) {
		return {
			displaySeasonNumber: resolvedDisplaySeasonNumber,
			displayEpisodeNumber: episode.episodeNumber
		};
	}

	const matchingSource = sortedSources[matchingSourceIndex];
	const sourceStart = matchingSource.tmdbEpisodeStart ?? 1;
	const withinSource = episode.episodeNumber - sourceStart + 1;
	const hasExactSourceMatch = exactSourceIndex == matchingSourceIndex;

	if (withinSource <= 0) {
		return {
			displaySeasonNumber: resolvedDisplaySeasonNumber,
			displayEpisodeNumber: episode.episodeNumber
		};
	}

	const offset = cumulativeEpisodeOffset(sortedSources, matchingSourceIndex);
	if (row.episodeNumberingMode === 'continuous') {
		if (row.episodeDisplayStart != null && hasExactSourceMatch && offset != null) {
			return {
				displaySeasonNumber: resolvedDisplaySeasonNumber,
				displayEpisodeNumber: row.episodeDisplayStart + offset + withinSource - 1
			};
		}
		return {
			displaySeasonNumber: resolvedDisplaySeasonNumber,
			displayEpisodeNumber: episode.episodeNumber
		};
	}

	if (!hasExactSourceMatch || offset == null) {
		return {
			displaySeasonNumber: resolvedDisplaySeasonNumber,
			displayEpisodeNumber: episode.episodeNumber
		};
	}

	return {
		displaySeasonNumber: resolvedDisplaySeasonNumber,
		displayEpisodeNumber: offset + withinSource
	};
}
