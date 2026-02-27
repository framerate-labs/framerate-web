import type {
	AniListMediaCore,
	AnimeMatchCandidate,
	AnimeMatchResult,
	TMDBAnimeSource
} from '../types/animeTypes';

const ACCEPT_THRESHOLD = 0.74;
const MIN_MARGIN = 0.08;
const STRONG_ANCHOR_MIN_SCORE = 0.84;
const STRONG_ANCHOR_MIN_MARGIN = 0.045;
const STAGE_B_TRIGGER_SCORE_FLOOR = 0.75;
const STAGE_B_TOP_CANDIDATES = 4;

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\b(season|part|cour)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleVariants(title: {
	romaji: string | null;
	english: string | null;
	native: string | null;
}): string[] {
	return [title.romaji, title.english, title.native].filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0
	);
}

function tokenize(value: string): Set<string> {
	return new Set(
		normalizeText(value)
			.split(' ')
			.map((token) => token.trim())
			.filter((token) => token.length > 0)
	);
}

function extractTitleYears(value: string): number[] {
	const matches = value.match(/\b(19|20)\d{2}\b/g);
	if (!matches) return [];
	return matches
		.map((token) => Number(token))
		.filter((year) => Number.isFinite(year) && year >= 1900 && year <= 2100);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection += 1;
	}
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

function scoreTitle(sourceTitles: string[], candidateTitles: string[]): number {
	let best = 0;
	for (const sourceTitle of sourceTitles) {
		const sourceNormalized = normalizeText(sourceTitle);
		if (sourceNormalized.length === 0) continue;
		const sourceTokens = tokenize(sourceNormalized);
		for (const candidateTitle of candidateTitles) {
			const candidateNormalized = normalizeText(candidateTitle);
			if (candidateNormalized.length === 0) continue;
			let score = jaccard(sourceTokens, tokenize(candidateNormalized));
			if (sourceNormalized === candidateNormalized) score = Math.max(score, 1);
			if (
				sourceNormalized.length >= 4 &&
				(candidateNormalized.includes(sourceNormalized) ||
					sourceNormalized.includes(candidateNormalized))
			) {
				score = Math.max(score, 0.9);
			}
			best = Math.max(best, score);
		}
	}
	return best;
}

function scoreYear(sourceYear: number | null, candidateYear: number | null): number {
	if (sourceYear === null || candidateYear === null) return 0.25;
	const delta = Math.abs(sourceYear - candidateYear);
	if (delta === 0) return 1;
	if (delta === 1) return 0.7;
	if (delta === 2) return 0.35;
	return 0;
}

function sourceStartYear(source: TMDBAnimeSource): number | null {
	const seasonYears = source.seasons
		.map((season) => {
			const year = season.airDate ? Number(season.airDate.slice(0, 4)) : null;
			return Number.isFinite(year) ? (year as number) : null;
		})
		.filter((year): year is number => year != null && year > 1900);
	if (seasonYears.length > 0) return Math.min(...seasonYears);
	return source.releaseYear;
}

function sourceEndYear(source: TMDBAnimeSource): number | null {
	const seasonYears = source.seasons
		.map((season) => {
			const year = season.airDate ? Number(season.airDate.slice(0, 4)) : null;
			return Number.isFinite(year) ? (year as number) : null;
		})
		.filter((year): year is number => year != null && year > 1900);
	if (seasonYears.length > 0) return Math.max(...seasonYears);
	return source.releaseYear;
}

function scoreEpisodes(
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

function scoreTvAnchorEpisodes(
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

function scoreFormat(tmdbType: 'movie' | 'tv', candidateFormat: string | null | undefined): number {
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

function tvAnchorFormatGate(format: string | null | undefined): number {
	if (format === 'TV') return 1;
	if (format === 'TV_SHORT') return 0.9;
	if (format === 'ONA') return 0.35;
	if (format === 'OVA') return 0.25;
	if (format === 'SPECIAL') return 0.15;
	if (format === 'MOVIE') return 0.05;
	return 0.1;
}

function candidateReason(parts: Array<[string, number]>): string {
	return parts.map(([label, value]) => `${label}:${value.toFixed(2)}`).join(', ');
}

function scoreExactDateCloseness(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
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

function scoreStatusConsistency(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
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

function scoreYearTagConsistency(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
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

function normalizedStudioName(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ');
	trim();
}

function scoreStudioOverlap(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
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

function scoreEndYearConsistency(source: TMDBAnimeSource, candidate: AniListMediaCore): number {
	const sourceYear = sourceEndYear(source);
	const candidateYear = candidate.endDate?.year ?? null;
	if (sourceYear == null || candidateYear == null) return 0.45;
	const delta = Math.abs(sourceYear - candidateYear);
	if (delta === 0) return 1;
	if (delta === 1) return 0.75;
	if (delta === 2) return 0.45;
	return 0.1;
}

function stageBReRank(
	source: TMDBAnimeSource,
	rows: Array<{
		candidate: AniListMediaCore;
		score: number;
		reason: string;
		titleScore: number;
		yearScore: number;
		episodeScore: number;
		formatScore: number;
	}>
) {
	const topRows = rows.slice(0, STAGE_B_TOP_CANDIDATES);
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

	return [...reranked, ...rows.slice(STAGE_B_TOP_CANDIDATES)];
}

export function matchTMDBAnimeToAniListCandidates(
	source: TMDBAnimeSource,
	candidates: AniListMediaCore[]
): AnimeMatchResult {
	const sourceTitles = [source.title, source.originalTitle].filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0
	);

	const scored = candidates
		.map((candidate) => {
			const candidateYear = candidate.startDate?.year ?? candidate.seasonYear ?? null;
			const titleScore = scoreTitle(sourceTitles, titleVariants(candidate.title));
			const yearScore = scoreYear(source.releaseYear, candidateYear);
			const episodeScore =
				source.tmdbType === 'tv'
					? scoreTvAnchorEpisodes(source, candidate.episodes ?? null, candidateYear)
					: scoreEpisodes(source.episodes, candidate.episodes ?? null, source.tmdbType);
			const formatScore =
				source.tmdbType === 'tv'
					? tvAnchorFormatGate(candidate.format)
					: scoreFormat(source.tmdbType, candidate.format);
			const score = titleScore * 0.56 + yearScore * 0.18 + episodeScore * 0.14 + formatScore * 0.12;

			const reasons: Array<[string, number]> = [
				['title', titleScore],
				['year', yearScore],
				['episodes', episodeScore],
				['format', formatScore]
			];
			return {
				candidate,
				score,
				reason: candidateReason(reasons),
				titleScore,
				yearScore,
				episodeScore,
				formatScore
			};
		})
		.sort((a, b) => b.score - a.score);

	let filteredScored = scored;
	if (source.tmdbType === 'tv') {
		const tvCandidates = scored.filter(
			(row) => row.candidate.format === 'TV' || row.candidate.format === 'TV_SHORT'
		);
		if (tvCandidates.length > 0 && (tvCandidates[0]?.score ?? 0) >= 0.62) {
			filteredScored = [...tvCandidates, ...scored.filter((row) => !tvCandidates.includes(row))];
		}
	}

	const bestPre = filteredScored[0];
	const secondPre = filteredScored[1];
	const marginPre = (bestPre?.score ?? 0) - (secondPre?.score ?? 0);
	const shouldRunStageB =
		(bestPre?.score ?? 0) >= STAGE_B_TRIGGER_SCORE_FLOOR && marginPre < MIN_MARGIN;

	if (shouldRunStageB) {
		filteredScored = stageBReRank(source, filteredScored);
	}

	const topCandidates: AnimeMatchCandidate[] = filteredScored.slice(0, 5).map((row) => ({
		anilistId: row.candidate.id,
		score: Number(row.score.toFixed(4)),
		why: row.reason
	}));

	const best = filteredScored[0];
	const second = filteredScored[1];
	if (!best) {
		return {
			accepted: false,
			method: 'title_year_episodes',
			confidence: 0,
			selected: null,
			candidates: [],
			reason: 'no_candidates'
		};
	}

	const margin = best.score - (second?.score ?? 0);
	const standardAccepted = best.score >= ACCEPT_THRESHOLD && margin >= MIN_MARGIN;
	const strongAnchorAccepted =
		best.score >= STRONG_ANCHOR_MIN_SCORE &&
		margin >= STRONG_ANCHOR_MIN_MARGIN &&
		best.titleScore >= 0.99 &&
		best.yearScore >= 1 &&
		best.formatScore >= (source.tmdbType === 'tv' ? 0.9 : 1);
	const accepted = standardAccepted || strongAnchorAccepted;
	const rejectionReason = standardAccepted
		? undefined
		: strongAnchorAccepted
			? undefined
			: `low_confidence(score=${best.score.toFixed(2)}, margin=${margin.toFixed(2)}${shouldRunStageB ? ', stageB=true' : ''})`;
	const acceptanceReason =
		!accepted || standardAccepted ? undefined : 'accepted_strong_anchor(title+year+format)';

	return {
		accepted,
		method: 'title_year_episodes',
		confidence: Number(best.score.toFixed(4)),
		selected: accepted ? best.candidate : null,
		candidates: topCandidates,
		reason: acceptanceReason ?? rejectionReason
	};
}
