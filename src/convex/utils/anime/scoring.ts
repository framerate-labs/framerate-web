import type { ScoredAnimeMatchRow } from '../../types/animeMatchTypes';
import type { AniListMediaCore, TMDBAnimeSource } from '../../types/animeTypes';

import {
	extractTitleYears,
	normalizedStudioName,
	normalizeText,
	titleVariants,
	tokenize
} from '../anime/normalizers';

export function scoreTitle(sourceTitles: string[], candidateTitles: string[]): number {
	const preparedSource = sourceTitles
		.map((value) => normalizeText(value))
		.filter((value) => value.length > 0)
		.map((normalized) => ({
			normalized,
			tokens: tokenize(normalized)
		}));
	const preparedCandidate = candidateTitles
		.map((value) => normalizeText(value))
		.filter((value) => value.length > 0)
		.map((normalized) => ({
			normalized,
			tokens: tokenize(normalized)
		}));

	let best = 0;
	for (const source of preparedSource) {
		for (const candidate of preparedCandidate) {
			let score = jaccard(source.tokens, candidate.tokens);
			if (source.normalized === candidate.normalized) score = Math.max(score, 1);
			if (
				source.normalized.length >= 4 &&
				(candidate.normalized.includes(source.normalized) ||
					source.normalized.includes(candidate.normalized))
			) {
				score = Math.max(score, 0.9);
			}
			best = Math.max(best, score);
		}
	}
	return best;
}

export function scoreYear(sourceYear: number | null, candidateYear: number | null): number {
	if (sourceYear === null || candidateYear === null) return 0.25;
	const delta = Math.abs(sourceYear - candidateYear);
	if (delta === 0) return 1;
	if (delta === 1) return 0.7;
	if (delta === 2) return 0.35;
	return 0;
}

export function sourceStartYear(source: TMDBAnimeSource): number | null {
	const seasonYears = source.seasons
		.map((season) => {
			const year = season.airDate ? Number(season.airDate.slice(0, 4)) : null;
			return Number.isFinite(year) ? (year as number) : null;
		})
		.filter((year): year is number => year != null && year > 1900);
	if (seasonYears.length > 0) return Math.min(...seasonYears);
	return source.releaseYear;
}

export function sourceEndYear(source: TMDBAnimeSource): number | null {
	const seasonYears = source.seasons
		.map((season) => {
			const year = season.airDate ? Number(season.airDate.slice(0, 4)) : null;
			return Number.isFinite(year) ? (year as number) : null;
		})
		.filter((year): year is number => year != null && year > 1900);
	if (seasonYears.length > 0) return Math.max(...seasonYears);
	return source.releaseYear;
}

export function scoreEpisodes(
	sourceEpisodes: number | null,
	candidateEpisodes: number | null,
	tmdbType: 'movie' | 'tv'
): number {
	if (tmdbType === 'movie') return 0.5;
	if (sourceEpisodes === null || candidateEpisodes === null) return 0.35;
	if (sourceEpisodes === candidateEpisodes) return 1;
	const delta = Math.abs(sourceEpisodes - candidateEpisodes);
	if (delta <= 1) return 0.85;
	if (delta <= 3) return 0.6;
	if (delta <= 6) return 0.35;
	return 0.05;
}

export function scoreTvAnchorEpisodes(
	source: TMDBAnimeSource,
	candidateEpisodes: number | null,
	candidateYear: number | null
): number {
	if (candidateEpisodes === null) return 0.35;

	const nonSpecialSeasons = source.seasons.filter((season) => season.seasonNumber > 0);
	const earliestSeason = nonSpecialSeasons.slice().sort((a, b) => {
		const ay = a.airDate ? Number(a.airDate.slice(0, 4)) : Number.POSITIVE_INFINITY;
		const by = b.airDate ? Number(b.airDate.slice(0, 4)) : Number.POSITIVE_INFINITY;
		if (Number.isFinite(ay) && Number.isFinite(by) && ay !== by) return ay - by;
		return a.seasonNumber - b.seasonNumber;
	})[0];

	const seasonEpisodeCounts = nonSpecialSeasons
		.map((season) => season.episodeCount)
		.filter((count) => Number.isFinite(count) && count > 0);

	const primaryTarget =
		earliestSeason && earliestSeason.episodeCount > 0 ? earliestSeason.episodeCount : null;
	const bestSeasonCountMatch =
		seasonEpisodeCounts.length === 0
			? 0
			: Math.max(
					...seasonEpisodeCounts.map((count) => scoreEpisodes(count, candidateEpisodes, 'tv'))
				);

	const primaryScore =
		primaryTarget === null ? 0 : scoreEpisodes(primaryTarget, candidateEpisodes, 'tv');

	let yearBonus = 0;
	const earliestYear =
		earliestSeason?.airDate && earliestSeason.airDate.length >= 4
			? Number(earliestSeason.airDate.slice(0, 4))
			: source.releaseYear;
	if (earliestYear !== null && candidateYear !== null) {
		if (candidateYear === earliestYear) yearBonus = 0.1;
		else if (Math.abs(candidateYear - earliestYear) === 1) yearBonus = 0.04;
		else if (candidateYear < earliestYear) yearBonus = -0.05;
	}

	return Math.max(0, Math.min(1, Math.max(primaryScore, bestSeasonCountMatch * 0.88) + yearBonus));
}

export function scoreFormat(
	tmdbType: 'movie' | 'tv',
	candidateFormat: string | null | undefined
): number {
	if (!candidateFormat) return 0.25;
	if (tmdbType === 'movie') {
		if (candidateFormat === 'MOVIE') return 1;
		if (candidateFormat === 'SPECIAL') return 0.3;
		return 0;
	}
	if (candidateFormat === 'TV') return 1;
	if (candidateFormat === 'TV_SHORT') return 0.8;
	if (candidateFormat === 'ONA' || candidateFormat === 'OVA') return 0.45;
	if (candidateFormat === 'MOVIE') return 0.05;
	return 0.2;
}

export function tvAnchorFormatGate(format: string | null | undefined): number {
	if (format === 'TV') return 1;
	if (format === 'TV_SHORT') return 0.9;
	if (format === 'ONA') return 0.35;
	if (format === 'OVA') return 0.25;
	if (format === 'SPECIAL') return 0.15;
	if (format === 'MOVIE') return 0.05;
	return 0.1;
}

export function candidateReason(parts: Array<[string, number]>): string {
	return parts.map(([label, value]) => `${label}:${value.toFixed(2)}`).join(', ');
}

export function scoreExactDateCloseness(
	source: TMDBAnimeSource,
	candidate: AniListMediaCore
): number {
	const sourceDate = source.releaseDate;
	const candidateDate = candidate.startDate;
	if (!sourceDate || !candidateDate || candidateDate.year == null) return 0.35;
	const sourceYear = Number(sourceDate.slice(0, 4));
	const sourceMonth = Number(sourceDate.slice(5, 7));
	const sourceDay = Number(sourceDate.slice(8, 10));
	if (!Number.isFinite(sourceYear)) return 0.35;
	if (sourceYear !== candidateDate.year) return 0;
	if (candidateDate.month == null || candidateDate.day == null) return 0.75;
	if (candidateDate.month === sourceMonth && candidateDate.day === sourceDay) return 1;
	if (candidateDate.month === sourceMonth) return 0.88;
	return 0.72;
}

export function scoreStatusConsistency(
	source: TMDBAnimeSource,
	candidate: AniListMediaCore
): number {
	const sourceStatus = source.details.status.toLowerCase();
	const candidateStatus = (candidate.status ?? '').toLowerCase();
	if (!candidateStatus) return 0.45;
	const sourceEnded =
		sourceStatus.includes('ended') ||
		sourceStatus.includes('cancelled') ||
		sourceStatus.includes('canceled');
	const candidateEnded =
		candidateStatus.includes('finished') || candidateStatus.includes('cancelled');
	const candidateReleasing = candidateStatus.includes('releasing');
	if (sourceEnded && candidateEnded) return 1;
	if (!sourceEnded && candidateReleasing) return 0.95;
	if (sourceEnded && candidateReleasing) return 0.1;
	if (!sourceEnded && candidateEnded) return 0.45;
	return 0.65;
}

export function scoreYearTagConsistency(
	source: TMDBAnimeSource,
	candidate: AniListMediaCore
): number {
	const sourceYear = source.releaseYear;
	if (sourceYear == null) return 0.5;
	const candidateTitles = titleVariants(candidate.title);
	if (candidateTitles.length === 0) return 0.5;
	let sawYearTag = false;
	for (const title of candidateTitles) {
		const years = extractTitleYears(title);
		if (years.length === 0) continue;
		sawYearTag = true;
		if (years.includes(sourceYear)) return 1;
	}
	return sawYearTag ? 0 : 0.6;
}

export function scoreStudioOverlap(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
	const sourceStudios = source.details.productionCompanies
		.map((company) => normalizedStudioName(company.name))
		.filter((name) => name.length > 0);
	const candidateStudios = (candidate.studios ?? [])
		.map((studio) => normalizedStudioName(studio.name))
		.filter((name) => name.length > 0);
	if (sourceStudios.length === 0 || candidateStudios.length === 0) return 0.45;
	for (const sourceStudio of sourceStudios) {
		for (const candidateStudio of candidateStudios) {
			if (sourceStudio === candidateStudio) return 1;
			if (
				sourceStudio.length >= 4 &&
				(candidateStudio.includes(sourceStudio) || sourceStudio.includes(candidateStudio))
			) {
				return 0.85;
			}
		}
	}
	return 0.2;
}

export function scoreEndYearConsistency(
	source: TMDBAnimeSource,
	candidate: AniListMediaCore
): number {
	const sourceYear = sourceEndYear(source);
	const candidateYear = candidate.endDate?.year ?? null;
	if (sourceYear == null || candidateYear == null) return 0.45;
	const delta = Math.abs(sourceYear - candidateYear);
	if (delta === 0) return 1;
	if (delta === 1) return 0.75;
	if (delta === 2) return 0.45;
	return 0.1;
}

export function stageBReRank(
	source: TMDBAnimeSource,
	rows: ScoredAnimeMatchRow[],
	options: {
		topCandidates: number;
	}
): ScoredAnimeMatchRow[] {
	const topRows = rows.slice(0, options.topCandidates);
	const sourceYear = source.releaseYear;
	const startYear = sourceStartYear(source);

	const reranked = topRows
		.map((row) => {
			const candidate = row.candidate;
			const candidateYear = candidate.startDate?.year ?? candidate.seasonYear ?? null;
			const dateScore = scoreExactDateCloseness(source, candidate);
			const statusScore = scoreStatusConsistency(source, candidate);
			const endYearScore = scoreEndYearConsistency(source, candidate);
			const yearTagScore = scoreYearTagConsistency(source, candidate);
			const studioScore = scoreStudioOverlap(source, candidate);
			let penalty = 0;
			if (sourceYear != null && candidateYear != null && Math.abs(sourceYear - candidateYear) > 3) {
				penalty += 0.22;
			}
			if (startYear != null && candidateYear != null && candidateYear < startYear - 3) {
				penalty += 0.1;
			}
			if (row.formatScore <= 0.15) {
				penalty += 0.12;
			}
			const rerankScore = Math.max(
				0,
				Math.min(
					1,
					row.titleScore * 0.34 +
						row.yearScore * 0.14 +
						row.episodeScore * 0.1 +
						row.formatScore * 0.08 +
						dateScore * 0.14 +
						statusScore * 0.06 +
						endYearScore * 0.04 +
						yearTagScore * 0.06 +
						studioScore * 0.04 -
						penalty
				)
			);
			const why = candidateReason([
				['title', row.titleScore],
				['year', row.yearScore],
				['episodes', row.episodeScore],
				['format', row.formatScore],
				['date', dateScore],
				['status', statusScore],
				['endYear', endYearScore],
				['titleYearTag', yearTagScore],
				['studio', studioScore],
				['penalty', -penalty]
			]);
			return {
				...row,
				score: rerankScore,
				reason: why
			};
		})
		.sort((a, b) => b.score - a.score);

	return [...reranked, ...rows.slice(options.topCandidates)];
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection += 1;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
