import type { getMovieBySource, getTVShowBySource } from '../utils/mediaLookup';

export type MovieMedia = NonNullable<Awaited<ReturnType<typeof getMovieBySource>>>;
export type TVMedia = NonNullable<Awaited<ReturnType<typeof getTVShowBySource>>>;
export type ReviewMediaType = 'movie' | 'tv';

export type ResolvedMedia =
	| { mediaType: 'movie'; media: MovieMedia }
	| { mediaType: 'tv'; media: TVMedia };

export type ReviewSnapshot = {
	liked: boolean;
	watched: boolean;
	review: string | null;
	rating: string;
	createdAt: number;
};

export type ExternalSourceIds = {
	tmdbId?: number;
	traktId?: number;
	imdbId?: string;
};

type DetailSeedCommon = ExternalSourceIds & {
	title: string;
	posterPath: string | null;
	backdropPath: null;
	releaseDate: null;
	overview: null;
	status: null;
	creatorCredits: [];
	detailSchemaVersion: number;
	detailFetchedAt: null;
	nextRefreshAt: number;
	refreshErrorCount: number;
	lastRefreshErrorAt: null;
};

export type MovieSeedData = DetailSeedCommon & {
	runtime: null;
	director: null;
};

export type TVSeedData = DetailSeedCommon & {
	numberOfSeasons: null;
	lastAirDate: null;
	lastEpisodeToAir: null;
	nextEpisodeToAir: null;
	creator: null;
};
