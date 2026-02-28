export type EpisodeCacheRequest = {
	tmdbId: number;
	seasonNumber: number;
};

export type TMDBSeasonEpisodeRow = {
	id: number;
	name: string;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	episodeNumber: number;
	seasonNumber: number;
	stillPath: string | null;
};

export type TVEpisodeRefreshSignals = {
	tmdbId: number;
	status: string | null;
	lastAirDate: string | null;
	lastEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
	nextEpisodeToAir: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null;
};

export type SeasonEpisodesCacheStatus = 'empty' | 'partial' | 'stale' | 'fresh';

export type DisplaySeasonStatus = 'open' | 'soft_closed' | 'auto_soft_closed' | 'closed' | null;

export type SeasonSourceInput = {
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
