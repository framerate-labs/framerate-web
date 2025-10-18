interface Genre {
	id: number;
	name: string;
}

interface ProductionCompany {
	id: number;
	logoPath?: string;
	name: string;
	originCountry: string;
}

interface ProductionCountry {
	iso31661: string;
	name: string;
}

interface SpokenLanguage {
	englishName: string;
	iso6391: string;
	name: string;
}

interface Credits {
	cast: {
		adult: boolean;
		gender: number;
		id: number;
		knownForDepartment: string;
		name: string;
		originalName: string;
		popularity: number;
		profilePath?: string;
		character: string;
		creditId: string;
		order: number;
		castId?: number;
	}[];
	crew: {
		adult: boolean;
		gender: number;
		id: number;
		knownForDepartment: string;
		name: string;
		originalName: string;
		popularity: number;
		profilePath?: string;
		creditId: string;
		department: string;
		job: string;
	}[];
}

interface MediaBase {
	adult: boolean;
	backdropPath: string;
	genres: Genre[];
	homepage: string;
	id: number;
	originCountry: string[];
	originalLanguage: string;
	overview: string;
	popularity: number;
	posterPath: string;
	productionCompanies: ProductionCompany[];
	productionCountries: ProductionCountry[];
	releaseDate: Date | null;
	spokenLanguages: SpokenLanguage[];
	status: string;
	tagline: string;
	voteAverage: number;
	voteCount: number;
	credits: Credits;
}

interface TVDetails extends MediaBase {
	mediaType: 'tv';
	creator: string;
	creatorList: {
		id: number;
		creditId: string;
		name: string;
		originalName: string;
		gender: number;
		profilePath: string | null;
	}[];
	episodeRunTime: number[];
	inProduction: boolean;
	languages: string[];
	lastAirDate: string;
	lastEpisodeToAir: {
		id: number;
		name: string;
		overview: string;
		voteAverage: number;
		voteCount: number;
		airDate: string;
		episodeNumber: number;
		episodeType: string;
		productionCode: string;
		runtime: number;
		seasonNumber: number;
		showId: number;
		stillPath: string;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	nextEpisodeToAir: any;
	networks: {
		id: number;
		logoPath: string;
		name: string;
		originCountry: string;
	}[];
	numberOfEpisodes: number;
	numberOfSeasons: number;
	originalTitle: string;
	releaseDate: Date;
	seasons: {
		airDate: string;
		episodeCount: number;
		id: number;
		name: string;
		overview: string;
		posterPath: string;
		seasonNumber: number;
		voteAverage: number;
	}[];
	title: string;
	type: string;
}

interface MovieDetails extends MediaBase {
	mediaType: 'movie';
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	belongsToCollection: any;
	budget: number;
	director: string;
	directorList: {
		adult: boolean;
		id: number;
		name: string;
		popularity: number;
		gender: number;
		known_for_department: string;
		original_name: string;
		profile_path: string | null;
		credit_id: string;
		department: string;
		job: string;
	}[];
	imdbId: string;
	originalTitle: string;
	revenue: number;
	runtime: number;
	title: string;
	video: boolean;
}

export type MediaDetails<T = 'movie' | 'tv'> = T extends 'movie'
	? MovieDetails
	: T extends 'tv'
		? TVDetails
		: never;
