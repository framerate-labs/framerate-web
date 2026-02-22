import type { Id } from '../_generated/dataModel';

export type WorkMediaType = 'movie' | 'tv';

export type WorkRow = {
	mediaType: WorkMediaType;
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string | null;
	role: string | null;
	billingOrder: number | null;
};

export type AnnotatedWork = {
	mediaType: WorkMediaType;
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string | null;
	role: string | null;
	inLibrary: boolean;
	watched: boolean;
};

export type PersonMediaReference = {
	mediaType: WorkMediaType;
	tmdbId: number;
	billingOrder: number;
};

export type ResolvedMovieReference = {
	tmdbId: number;
	billingOrder: number;
	movieId: Id<'movies'>;
};

export type ResolvedTVReference = {
	tmdbId: number;
	billingOrder: number;
	tvShowId: Id<'tvShows'>;
};

export type DesiredMovieLink = {
	mediaTmdbId: number;
	movieId: Id<'movies'>;
	billingOrder: number;
};

export type DesiredTVLink = {
	mediaTmdbId: number;
	tvShowId: Id<'tvShows'>;
	billingOrder: number;
};

export type ManagedLinkRowId = Id<'movieCredits'> | Id<'tvCredits'> | Id<'movieCompanies'> | Id<'tvCompanies'>;

export type WorkLibraryState = {
	mediaType: WorkMediaType;
	tmdbId: number;
	inLibrary: boolean;
	watched: boolean;
};

export type WorksQueryContext = {
	personTmdbId?: number;
	companyTmdbId?: number;
};

export type TMDBPersonCredit = {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	department?: string | null;
	job?: string | null;
	credit_id?: string;
	order?: number;
	title?: string;
	name?: string;
	poster_path?: string | null;
	release_date?: string | null;
	first_air_date?: string | null;
};

export type TMDBPersonDetailsResponse = {
	id: number;
	name: string;
	profile_path: string | null;
	biography?: string | null;
	combined_credits?: {
		cast?: TMDBPersonCredit[];
		crew?: TMDBPersonCredit[];
	};
};

export type TMDBCompanyDetailsResponse = {
	id: number;
	name: string;
	logo_path: string | null;
	description?: string | null;
};

export type TMDBDiscoverResponse = {
	page?: number;
	total_pages?: number;
	results?: Array<{
		id?: number;
		title?: string;
		name?: string;
		poster_path?: string | null;
		release_date?: string | null;
		first_air_date?: string | null;
	}>;
};
