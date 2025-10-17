export type TrendingFilter = 'all' | 'movie' | 'tv' | 'person';
export type TrendingTimeWindow = 'day' | 'week';

export type TrendingApiItem =
	| {
			media_type: 'movie';
			adult: boolean;
			backdrop_path: string | null;
			genre_ids: number[];
			id: number;
			original_language: string;
			overview: string;
			popularity: number;
			poster_path: string | null;
			original_title: string;
			release_date: string;
			title: string;
			vote_average: number;
			vote_count: number;
			video: boolean;
	  }
	| {
			media_type: 'tv';
			adult: boolean;
			backdrop_path: string | null;
			genre_ids: number[];
			id: number;
			original_language: string;
			overview: string;
			popularity: number;
			poster_path: string | null;
			first_air_date: string;
			name: string;
			origin_country: string[];
			original_name: string;
			vote_average: number;
			vote_count: number;
	  }
	| {
			media_type: 'person';
			adult: boolean;
			gender: number;
			id: number;
			known_for_department: string;
			name: string;
			original_name: string;
			popularity: number;
			profile_path: string | null;
	  };

export type TrendingMovie = {
	mediaType: 'movie';
	id: number;
	title: string;
	originalTitle: string;
	releaseDate: string;
	posterPath: string | null;
	backdropPath: string | null;
	overview: string;
	genreIds: number[];
	originalLanguage: string;
	popularity: number;
	voteAverage: number;
	voteCount: number;
	video: boolean;
	adult: boolean;
};

export type TrendingTV = {
	mediaType: 'tv';
	id: number;
	title: string;
	originalTitle: string;
	releaseDate: string;
	posterPath: string | null;
	backdropPath: string | null;
	overview: string;
	genreIds: number[];
	originalLanguage: string;
	popularity: number;
	voteAverage: number;
	voteCount: number;
	originCountry: string[];
	adult: boolean;
};

export type TrendingPerson = {
	mediaType: 'person';
	id: number;
	name: string;
	originalName: string;
	profilePath: string | null;
	popularity: number;
	adult: boolean;
	knownForDepartment: string;
	gender: number;
};

export type Trending<T extends TrendingFilter = 'all'> = T extends 'movie'
	? TrendingMovie
	: T extends 'tv'
		? TrendingTV
		: T extends 'person'
			? TrendingPerson
			: TrendingMovie | TrendingTV | TrendingPerson;
