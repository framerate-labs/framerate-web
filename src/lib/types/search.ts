export interface SearchResults {
	results: SearchBase[];
}

export type SearchBase = {
	backdrop_path: string;
	id: number;
	name: string;
	title: string;
	original_name: string;
	overview: string;
	poster_path: string;
	media_type: 'movie' | 'tv' | 'person';
	adult: boolean;
	original_language: string;
	original_title: string;
	genre_ids: number[];
	popularity: number;
	first_air_date: string;
	vote_average: number;
	vote_count: number;
	origin_country: string[];
	release_date: string;
	gender: number;
	known_for_department: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	profile_path: any;
	known_for: KnownFor[];
};

type KnownFor = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	backdrop_path: any;
	id: number;
	title: string;
	original_title: string;
	overview: string;
	poster_path: string;
	media_type: 'movie' | 'tv';
	adult: boolean;
	original_language: string;
	genre_ids: number[];
	popularity: number;
	release_date: string;
	video: boolean;
	vote_average: number;
	vote_count: number;
};
