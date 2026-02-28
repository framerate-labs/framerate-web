import type { ScoredAnimeMatchRow } from '../types/animeMatchTypes';
import type {
	AniListMediaCore,
	AnimeMatchCandidate,
	AnimeMatchResult,
	TMDBAnimeSource
} from '../types/animeTypes';

import { titleVariants } from '../utils/anime/normalizers';
import {
	candidateReason,
	scoreEpisodes,
	scoreFormat,
	scoreTitle,
	scoreTvAnchorEpisodes,
	scoreYear,
	stageBReRank,
	tvAnchorFormatGate
} from '../utils/anime/scoring';

const ACCEPT_THRESHOLD = 0.74;
const MIN_MARGIN = 0.08;
const STRONG_ANCHOR_MIN_SCORE = 0.84;
const STRONG_ANCHOR_MIN_MARGIN = 0.045;
const STAGE_B_TRIGGER_SCORE_FLOOR = 0.75;
const STAGE_B_TOP_CANDIDATES = 4;

export function matchTMDBAnimeToAniListCandidates(
	source: TMDBAnimeSource,
	candidates: AniListMediaCore[]
): AnimeMatchResult {
	const sourceTitles = [source.title, source.originalTitle].filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0
	);

	const scored: ScoredAnimeMatchRow[] = candidates
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

			return {
				candidate,
				score,
				reason: candidateReason([
					['title', titleScore],
					['year', yearScore],
					['episodes', episodeScore],
					['format', formatScore]
				]),
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
		filteredScored = stageBReRank(source, filteredScored, {
			topCandidates: STAGE_B_TOP_CANDIDATES
		});
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
