export type TimeWindow = 'day' | 'week';
export type Filter = 'all' | 'movie' | 'tv' | 'person';

// Raw TMDB response types (snake_case)
export interface TMDBMediaBase {
	adult: boolean;
	backdrop_path: string | null;
	genre_ids: number[];
	id: number;
	original_language: string;
	overview: string;
	popularity: number;
	poster_path: string | null;
	vote_average: number;
	vote_count: number;
}

export interface TMDBMovie extends TMDBMediaBase {
	media_type: 'movie';
	original_title: string;
	release_date: string;
	title: string;
	video: boolean;
}

export interface TMDBTVShow extends TMDBMediaBase {
	media_type: 'tv';
	first_air_date: string;
	name: string;
	origin_country: string[];
	original_name: string;
}

export interface TMDBPerson {
	adult: boolean;
	gender: number;
	id: number;
	known_for_department: string | null;
	media_type: 'person';
	name: string;
	original_name: string;
	popularity: number;
	profile_path: string | null;
}

export type TMDBTrendingItem = TMDBMovie | TMDBTVShow | TMDBPerson;

export interface TMDBTrendingResponse {
	page: number;
	results: TMDBTrendingItem[];
	total_pages: number;
	total_results: number;
}

// Normalized output type (camelCase, consistent shape)
export interface NormalizedTrendingItem {
	id: number;
	mediaType: 'movie' | 'tv' | 'person';
	title: string;
	originalTitle: string;
	overview?: string;
	posterPath: string | null;
	backdropPath: string | null;
	popularity: number;
	voteAverage?: number;
	voteCount?: number;
	releaseDate?: string;
	genreIds?: number[];
	adult: boolean;
	// Person-specific
	profilePath?: string | null;
	knownForDepartment?: string | null;
}
