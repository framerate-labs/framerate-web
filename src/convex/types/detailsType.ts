import type { Id } from '../_generated/dataModel';
import type { getMovieBySource, getTVShowBySource, MediaSource } from '../utils/mediaLookup';
import type { MediaType } from './mediaTypes';
import type { NormalizedMediaDetails } from './tmdb/detailsTypes';

export type SyncPolicy = 'tmdb_authoritative' | 'db_authoritative' | 'fill_if_empty';

export type EnrichmentCompanyInput = {
	tmdbId: number;
	name: string;
	logoPath: string | null;
	originCountry: string | null;
	role: string;
	billingOrder: number;
};

export type HeaderContributorSource = 'tmdb' | 'anilist';
export type HeaderContributorMatchMethod = 'exact' | 'normalized' | 'fuzzy' | 'manual';
export type AnimeStudioStatus = 'not_applicable' | 'pending' | 'resolved' | 'unavailable';

export type HeaderContributorInput = {
	type: 'person' | 'company';
	tmdbId: number | null;
	name: string;
	role: string | null;
	source?: HeaderContributorSource;
	sourceId?: number | null;
	matchMethod?: HeaderContributorMatchMethod | null;
	matchConfidence?: number | null;
};

export type StoredEpisodeSummary = {
	airDate: string | null;
	seasonNumber: number;
	episodeNumber: number;
};

export type StoredTVSeasonSummary = {
	id: number;
	name: string;
	overview: string | null;
	airDate: string | null;
	episodeCount: number | null;
	posterPath: string | null;
	seasonNumber: number;
	voteAverage: number | null;
};

export type StoredCastCredit = {
	id: number;
	adult: boolean;
	gender: number;
	knownForDepartment: string;
	name: string;
	originalName: string;
	popularity: number;
	profilePath: string | null;
	character: string;
	creditId: string;
	order: number;
	castId?: number | null;
};

export type StoredCrewCredit = {
	id: number;
	adult: boolean;
	gender: number;
	knownForDepartment: string;
	name: string;
	originalName: string;
	popularity: number;
	profilePath: string | null;
	creditId: string;
	department: string;
	job: string;
};

export type CreditCoverage = 'preview' | 'full';
export type CreditSource = 'tmdb' | 'anilist';

export type CreditCacheSnapshot = {
	mediaType: MediaType;
	tmdbId: number;
	source: CreditSource;
	seasonKey: string | null;
	coverage: CreditCoverage;
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	castTotal: number;
	crewTotal: number;
	fetchedAt: number;
	nextRefreshAt: number;
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
	seasons?: StoredTVSeasonSummary[] | null;
	lastAirDate?: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	posterPath?: string | null;
	backdropPath?: string | null;
	creatorCredits?: HeaderContributorInput[] | null;
	castCredits?: StoredCastCredit[] | null;
	crewCredits?: StoredCrewCredit[] | null;
	isAnime?: boolean | null;
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
	skipDetailRefresh?: boolean;
	creditSourceOverride?: CreditSource;
	creditCoverageTarget?: CreditCoverage;
	creditSeasonContext?: {
		seasonKey: string;
		tmdbSeasonNumber?: number | null;
		seasonOrdinal?: number | null;
		memberAnilistIds?: number[] | null;
	} | null;
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
	isAnimeSource?: 'auto' | 'manual';
	overview?: string | null;
	status?: string | null;
	runtime?: number | null;
	detailSchemaVersion?: number;
	detailFetchedAt?: number | null;
	nextRefreshAt?: number;
	refreshErrorCount?: number;
	creatorCredits?: HeaderContributorInput[];
	castCredits?: StoredCastCredit[];
	crewCredits?: StoredCrewCredit[];
};

export type StoredTVDoc = NonNullable<Awaited<ReturnType<typeof getTVShowBySource>>> & {
	isAnimeSource?: 'auto' | 'manual';
	overview?: string | null;
	status?: string | null;
	numberOfSeasons?: number | null;
	seasons?: StoredTVSeasonSummary[] | null;
	lastAirDate?: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	detailSchemaVersion?: number;
	detailFetchedAt?: number | null;
	nextRefreshAt?: number;
	refreshErrorCount?: number;
	creatorCredits?: HeaderContributorInput[];
	castCredits?: StoredCastCredit[];
	crewCredits?: StoredCrewCredit[];
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
	seasons?: StoredTVSeasonSummary[] | null;
	lastAirDate: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
	detailSchemaVersion: number;
	detailFetchedAt: number;
	nextRefreshAt: number;
	isAnime: boolean;
	isAnimeSource: 'auto' | 'manual';
	creatorCredits: HeaderContributorInput[];
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
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
	isAnime: boolean;
	isAnimeSource: 'auto' | 'manual';
	creatorCredits: HeaderContributorInput[];
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
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
	isAnime: boolean;
	isAnimeSource: 'auto' | 'manual';
	creatorCredits: HeaderContributorInput[];
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	overview: string | null;
	status: string;
	numberOfSeasons?: number | null;
	seasons?: StoredTVSeasonSummary[] | null;
	lastAirDate: string | null;
	lastEpisodeToAir?: StoredEpisodeSummary | null;
	nextEpisodeToAir?: StoredEpisodeSummary | null;
};

export type MoviePatch = Partial<Omit<MovieInsertDoc, keyof SourceIdentifiers>>;
export type TVPatch = Partial<Omit<TVInsertDoc, keyof SourceIdentifiers>>;

export type DetailRefreshLeaseId = Id<'detailRefreshLeases'>;
export type DetailMediaType = MediaType;
export type DetailMediaSource = MediaSource;
