import type { Id } from '../_generated/dataModel';
import type { MediaType } from './mediaTypes';
import type { NormalizedMediaDetails } from './tmdb/detailsTypes';
import type {
	MediaSource,
	getMovieBySource,
	getTVShowBySource
} from '../utils/mediaLookup';

export type SyncPolicy = 'tmdb_authoritative' | 'db_authoritative' | 'fill_if_empty';

export type EnrichmentCompanyInput = {
	tmdbId: number;
	name: string;
	logoPath: string | null;
	originCountry: string | null;
	role: string;
	billingOrder: number;
};

export type HeaderContributorInput = {
	type: 'person' | 'company';
	tmdbId: number | null;
	name: string;
	role: string | null;
};

export type StoredEpisodeSummary = {
	airDate: string | null;
	seasonNumber: number;
	episodeNumber: number;
};

export type DetailRefreshDecision = {
	needsRefresh: boolean;
	hardStale: boolean;
	reason: string;
};

export type StoredMediaSnapshot = {
	detailSchemaVersion?: number | null;
	detailFetchedAt?: number | null;
	nextRefreshAt?: number | null;
	releaseDate?: string | null;
	overview?: string | null;
	status?: string | null;
	runtime?: number | null;
	numberOfSeasons?: number | null;
	lastAirDate?: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	posterPath?: string | null;
	backdropPath?: string | null;
	director?: string | null;
	creator?: string | null;
	creatorCredits?: HeaderContributorInput[] | null;
};

export type RefreshIfStaleResult = {
	refreshed: boolean;
	reason: string;
	nextRefreshAt: number | null;
};

export type SweepStaleDetailsResult = {
	scanned: number;
	selected: number;
	refreshed: number;
	skipped: number;
	failed: number;
};

export type RefreshIfStaleArgs = {
	mediaType: 'movie' | 'tv';
	id: number | string;
	source?: 'tmdb' | 'trakt' | 'imdb';
	force?: boolean;
};

export type RefreshCandidate = {
	mediaType: 'movie' | 'tv';
	id: number;
	nextRefreshAt: number;
};

export type PreparedDetailSync = {
	details: NormalizedMediaDetails;
	isAnime: boolean;
	creatorCredits: HeaderContributorInput[];
};

export type StoredMovieDoc = NonNullable<Awaited<ReturnType<typeof getMovieBySource>>> & {
	overview?: string | null;
	status?: string;
	runtime?: number | null;
	detailSchemaVersion?: number;
	detailFetchedAt?: number;
	nextRefreshAt?: number;
	refreshErrorCount?: number;
	lastRefreshErrorAt?: number | null;
	creatorCredits?: HeaderContributorInput[];
};

export type StoredTVDoc = NonNullable<Awaited<ReturnType<typeof getTVShowBySource>>> & {
	overview?: string | null;
	status?: string;
	numberOfSeasons?: number;
	lastAirDate?: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	detailSchemaVersion?: number;
	detailFetchedAt?: number;
	nextRefreshAt?: number;
	refreshErrorCount?: number;
	lastRefreshErrorAt?: number | null;
	creatorCredits?: HeaderContributorInput[];
};

export type SourceIdentifiers = {
	tmdbId?: number;
	traktId?: number;
	imdbId?: string;
};

export type InsertMediaArgs = {
	mediaType: 'movie' | 'tv';
	source: MediaSource;
	externalId: number | string;
	title: string;
	posterPath: string | null;
	backdropPath: string | null;
	releaseDate: string | null;
	overview: string | null;
	status: string;
	runtime: number | null;
	numberOfSeasons?: number;
	lastAirDate: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	detailSchemaVersion: number;
	detailFetchedAt: number;
	nextRefreshAt: number;
	isAnime: boolean;
	director: string | null;
	creator: string | null;
	creatorCredits: HeaderContributorInput[];
};

export type MovieInsertDoc = SourceIdentifiers & {
	title: string;
	posterPath: string | null;
	backdropPath: string | null;
	releaseDate: string | null;
	detailSchemaVersion: number;
	detailFetchedAt: number;
	nextRefreshAt: number;
	refreshErrorCount: number;
	lastRefreshErrorAt: number | null;
	isAnime: boolean;
	director: string | null;
	creatorCredits: HeaderContributorInput[];
	overview: string | null;
	status: string;
	runtime: number | null;
};

export type TVInsertDoc = SourceIdentifiers & {
	title: string;
	posterPath: string | null;
	backdropPath: string | null;
	releaseDate: string | null;
	detailSchemaVersion: number;
	detailFetchedAt: number;
	nextRefreshAt: number;
	refreshErrorCount: number;
	lastRefreshErrorAt: number | null;
	isAnime: boolean;
	creator: string | null;
	creatorCredits: HeaderContributorInput[];
	overview: string | null;
	status: string;
	numberOfSeasons?: number | null;
	lastAirDate: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
};

export type MoviePatch = Partial<Omit<MovieInsertDoc, keyof SourceIdentifiers>>;
export type TVPatch = Partial<Omit<TVInsertDoc, keyof SourceIdentifiers>>;

export type DetailRefreshLeaseId = Id<'detailRefreshLeases'>;
export type DetailMediaType = MediaType;
export type DetailMediaSource = MediaSource;
