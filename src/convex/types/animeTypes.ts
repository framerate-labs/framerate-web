import type { Doc } from '../_generated/dataModel';
import type { MediaType } from './mediaTypes';
import type { NormalizedMediaDetails } from './tmdb/detailsTypes';

export type TMDBAnimeType = MediaType;

export type TMDBExternalIds = {
	imdbId: string | null;
	tvdbId: number | null;
};

export type TMDBAnimeSeasonSummary = {
	seasonNumber: number;
	name: string;
	episodeCount: number;
	airDate: string | null;
};

export type TMDBAnimeSpecialEpisodeSummary = {
	episodeNumber: number;
	name: string;
	airDate: string | null;
};

export type TMDBAnimeSource = {
	tmdbType: TMDBAnimeType;
	tmdbId: number;
	title: string;
	originalTitle: string;
	releaseDate: string | null;
	releaseYear: number | null;
	episodes: number | null;
	seasons: TMDBAnimeSeasonSummary[];
	specialEpisodes: TMDBAnimeSpecialEpisodeSummary[];
	isLikelyAnime: boolean;
	externalIds: TMDBExternalIds;
	details: NormalizedMediaDetails;
};

export type AniListTitleSet = {
	romaji: string | null;
	english: string | null;
	native: string | null;
};

export type AniListStudio = {
	anilistStudioId: number;
	name: string;
	isAnimationStudio?: boolean;
	isMain?: boolean;
};

export type AniListCharacterVoiceActor = {
	anilistStaffId: number;
	name: string;
	imageUrl: string | null;
};

export type AniListCharacter = {
	anilistCharacterId: number;
	name: string;
	imageUrl: string | null;
	role: string | null;
	voiceActor?: AniListCharacterVoiceActor | null;
	order: number;
};

export type AniListStaff = {
	anilistStaffId: number;
	name: string;
	imageUrl: string | null;
	role: string | null;
	department: string | null;
	order: number;
};

export type AniListDateParts = {
	year: number | null;
	month: number | null;
	day: number | null;
};

export type AniListMediaFormat =
	| 'TV'
	| 'TV_SHORT'
	| 'MOVIE'
	| 'SPECIAL'
	| 'OVA'
	| 'ONA'
	| 'MUSIC'
	| 'UNKNOWN'
	| string;

export type AniListRelationType =
	| 'SEQUEL'
	| 'PREQUEL'
	| 'SIDE_STORY'
	| 'PARENT'
	| 'SUMMARY'
	| 'ALTERNATIVE'
	| 'SPIN_OFF'
	| 'ADAPTATION'
	| 'CHARACTER'
	| 'OTHER'
	| string;

export type AniListMediaRelation = {
	anilistId: number;
	relationType: AniListRelationType;
	type?: string | null;
	title: AniListTitleSet;
	format?: AniListMediaFormat | null;
	status?: string | null;
	startDate?: AniListDateParts | null;
	seasonYear?: number | null;
	episodes?: number | null;
};

export type AniListMediaCore = {
	id: number;
	type?: string | null;
	title: AniListTitleSet;
	format?: AniListMediaFormat | null;
	status?: string | null;
	startDate?: AniListDateParts | null;
	endDate?: AniListDateParts | null;
	seasonYear?: number | null;
	episodes?: number | null;
	description?: string | null;
	studios?: AniListStudio[];
	characters?: AniListCharacter[];
	staff?: AniListStaff[];
	relations?: AniListMediaRelation[];
};

export type AnimeMatchCandidate = {
	anilistId: number;
	score: number;
	why?: string;
};

export type AnimeMatchResult = {
	accepted: boolean;
	method: 'title_year_episodes';
	confidence: number;
	selected: AniListMediaCore | null;
	candidates: AnimeMatchCandidate[];
	reason?: string;
};

export type AnimeXrefRow = Doc<'animeXref'>;
export type AniListMediaRow = Doc<'anilistMedia'>;
