import type { MediaType } from '../mediaTypes';

// Raw TMDB response types (snake_case)
export interface Genre {
	id: number;
	name: string;
}

export interface ProductionCompany {
	id: number;
	logo_path: string | null;
	name: string;
	origin_country: string;
}

export interface ProductionCountry {
	iso_3166_1: string;
	name: string;
}

export interface SpokenLanguage {
	english_name: string;
	iso_639_1: string;
	name: string;
}

export interface PersonCredit {
	adult: boolean;
	gender: number;
	id: number;
	known_for_department: string;
	name: string;
	original_name: string;
	popularity: number;
	profile_path: string | null;
	credit_id: string;
}

export interface CastMember extends PersonCredit {
	character: string;
	order: number;
	cast_id?: number;
}

export interface CrewMember extends PersonCredit {
	department: string;
	job: string;
}

export interface TMDBCredits {
	cast: CastMember[];
	crew: CrewMember[];
}

export interface AggregateCastRole {
	credit_id: string;
	character: string;
	episode_count: number;
}

export interface AggregateCrewJob {
	credit_id: string;
	job: string;
	department: string;
	episode_count: number;
}

export interface AggregateCastMember extends PersonCredit {
	order: number;
	total_episode_count: number;
	roles: AggregateCastRole[];
}

export interface AggregateCrewMember extends PersonCredit {
	department: string;
	total_episode_count: number;
	jobs: AggregateCrewJob[];
}

export interface TMDBAggregateCredits {
	cast: AggregateCastMember[];
	crew: AggregateCrewMember[];
}

export interface TMDBMediaBase {
	adult: boolean;
	backdrop_path: string | null;
	genres: Genre[];
	homepage: string | null;
	id: number;
	origin_country: string[];
	original_language: string;
	overview: string | null;
	popularity: number;
	poster_path: string | null;
	status: string;
	tagline: string | null;
	vote_average: number;
	vote_count: number;
	credits: TMDBCredits;
	production_companies: ProductionCompany[];
	production_countries: ProductionCountry[];
	spoken_languages: SpokenLanguage[];
}

export interface TMDBMovieDetails extends TMDBMediaBase {
	belongs_to_collection: {
		id: number;
		name: string;
		poster_path: string | null;
		backdrop_path: string | null;
	} | null;
	budget: number;
	imdb_id: string | null;
	original_title: string;
	release_date: string | null;
	revenue: number;
	runtime: number | null;
	title: string;
	video: boolean;
}

export interface TMDBTVCreator {
	id: number;
	credit_id: string;
	name: string;
	original_name: string;
	gender: number;
	profile_path: string | null;
}

export interface TMDBEpisode {
	id: number;
	name: string;
	overview: string | null;
	vote_average: number;
	vote_count: number;
	air_date: string | null;
	episode_number: number;
	episode_type: string;
	production_code: string | null;
	runtime: number | null;
	season_number: number;
	show_id: number;
	still_path: string | null;
}

export interface TMDBNetwork {
	id: number;
	logo_path: string | null;
	name: string;
	origin_country: string;
}

export interface TMDBSeason {
	air_date: string | null;
	episode_count: number;
	id: number;
	name: string;
	overview: string | null;
	poster_path: string | null;
	season_number: number;
	vote_average: number;
}

export interface TMDBTVDetails extends TMDBMediaBase {
	created_by: TMDBTVCreator[];
	episode_run_time: number[];
	first_air_date: string | null;
	in_production: boolean;
	languages: string[];
	last_air_date: string | null;
	last_episode_to_air: TMDBEpisode | null;
	name: string;
	next_episode_to_air: TMDBEpisode | null;
	networks: TMDBNetwork[];
	number_of_episodes: number;
	number_of_seasons: number;
	original_name: string;
	seasons: TMDBSeason[];
	type: string;
	aggregate_credits?: TMDBAggregateCredits;
}

// Normalized output types (camelCase)
export interface NormalizedGenre {
	id: number;
	name: string;
}

export interface NormalizedProductionCompany {
	id: number;
	logoPath: string | null;
	name: string;
	originCountry: string;
}

export interface NormalizedProductionCountry {
	iso31661: string;
	name: string;
}

export interface NormalizedSpokenLanguage {
	englishName: string;
	iso6391: string;
	name: string;
}

export interface NormalizedCastMember {
	adult: boolean;
	gender: number;
	id: number;
	knownForDepartment: string;
	name: string;
	originalName: string;
	popularity: number;
	profilePath: string | null;
	character: string;
	creditId: string;
	order: number;
	castId?: number;
}

export interface NormalizedCrewMember {
	adult: boolean;
	gender: number;
	id: number;
	knownForDepartment: string;
	name: string;
	originalName: string;
	popularity: number;
	profilePath: string | null;
	creditId: string;
	department: string;
	job: string;
}

export interface NormalizedCredits {
	cast: NormalizedCastMember[];
	crew: NormalizedCrewMember[];
}

export interface NormalizedMediaBase {
	adult: boolean;
	backdropPath: string | null;
	genres: NormalizedGenre[];
	homepage: string | null;
	id: number;
	originCountry: string[];
	originalLanguage: string;
	overview: string | null;
	popularity: number;
	posterPath: string | null;
	productionCompanies: NormalizedProductionCompany[];
	productionCountries: NormalizedProductionCountry[];
	spokenLanguages: NormalizedSpokenLanguage[];
	status: string;
	tagline: string | null;
	voteAverage: number;
	voteCount: number;
	credits: NormalizedCredits;
}

export interface NormalizedCreator {
	id: number;
	creditId: string;
	name: string;
	originalName: string;
	gender: number;
	profilePath: string | null;
}

export interface NormalizedEpisode {
	id: number;
	name: string;
	overview: string | null;
	voteAverage: number;
	voteCount: number;
	airDate: string | null;
	episodeNumber: number;
	episodeType: string;
	productionCode: string | null;
	runtime: number | null;
	seasonNumber: number;
	showId: number;
	stillPath: string | null;
}

export interface NormalizedNetwork {
	id: number;
	logoPath: string | null;
	name: string;
	originCountry: string;
}

export interface NormalizedSeason {
	airDate: string | null;
	episodeCount: number;
	id: number;
	name: string;
	overview: string | null;
	posterPath: string | null;
	seasonNumber: number;
	voteAverage: number;
}

export interface NormalizedMovieDetails extends NormalizedMediaBase {
	mediaType: 'movie';
	belongsToCollection: {
		id: number;
		name: string;
		posterPath: string | null;
		backdropPath: string | null;
	} | null;
	budget: number;
	director: string;
	directorList: NormalizedCrewMember[];
	imdbId: string | null;
	originalTitle: string;
	releaseDate: string | null;
	revenue: number;
	runtime: number | null;
	title: string;
	video: boolean;
}

export interface NormalizedTVDetails extends NormalizedMediaBase {
	mediaType: 'tv';
	creator: string;
	creatorList: NormalizedCreator[];
	episodeRunTime: number[];
	inProduction: boolean;
	languages: string[];
	lastAirDate: string | null;
	lastEpisodeToAir: NormalizedEpisode | null;
	networks: NormalizedNetwork[];
	nextEpisodeToAir: NormalizedEpisode | null;
	numberOfEpisodes: number;
	numberOfSeasons: number;
	originalTitle: string;
	releaseDate: string | null;
	seasons: NormalizedSeason[];
	title: string;
	type: string;
}

export type NormalizedMediaDetails = NormalizedMovieDetails | NormalizedTVDetails;
export type TMDBDetailsMediaType = MediaType;
