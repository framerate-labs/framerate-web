export interface TMDBSearchItem {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	overview?: string;
	poster_path: string | null;
	backdrop_path: string | null;
	popularity: number;
	release_date?: string;
	first_air_date?: string;
	vote_average?: number;
	vote_count?: number;
	adult: boolean;
}

export interface TMDBSearchResponse {
	results: TMDBSearchItem[];
}

export interface NormalizedSearchItem {
	id: number;
	mediaType: 'movie' | 'tv';
	title: string;
	originalTitle: string;
	overview?: string;
	posterPath: string | null;
	backdropPath: string | null;
	popularity: number;
	releaseDate: string | null;
	voteAverage: number | null;
	voteCount: number | null;
	adult: boolean;
}
