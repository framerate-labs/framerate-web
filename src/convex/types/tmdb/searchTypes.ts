export interface TMDBPersonKnownForItem {
	id?: number;
	media_type?: string;
	title?: string;
	name?: string;
}

export interface TMDBSearchItem {
	id: number;
	media_type: string;
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	overview?: string;
	poster_path: string | null;
	profile_path?: string | null;
	known_for_department?: string | null;
	known_for?: TMDBPersonKnownForItem[];
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
	mediaType: 'movie' | 'tv' | 'person';
	title: string;
	originalTitle: string;
	overview?: string;
	posterPath: string | null;
	knownForDepartment: string | null;
	releaseYear: number | null;
	backdropPath: string | null;
	popularity: number;
	releaseDate: string | null;
	voteAverage: number | null;
	voteCount: number | null;
	adult: boolean;
}
