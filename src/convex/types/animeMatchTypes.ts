import type { AniListMediaCore } from './animeTypes';

export type ScoredAnimeMatchRow = {
	candidate: AniListMediaCore;
	score: number;
	reason: string;
	titleScore: number;
	yearScore: number;
	episodeScore: number;
	formatScore: number;
};
