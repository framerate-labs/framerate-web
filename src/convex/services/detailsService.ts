/**
 * TMDB Details Service
 *
 * Handles fetching, validating, and normalizing movie/TV details from TMDB API.
 * Used by Convex actions to fetch media details on-demand.
 */

export type MediaType = 'movie' | 'tv';

type TMDBError = {
	success: boolean;
	status_code: number;
	status_message: string;
};

// Raw TMDB response types (snake_case)
interface Genre {
	id: number;
	name: string;
}

interface ProductionCompany {
	id: number;
	logo_path: string | null;
	name: string;
	origin_country: string;
}

interface ProductionCountry {
	iso_3166_1: string;
	name: string;
}

interface SpokenLanguage {
	english_name: string;
	iso_639_1: string;
	name: string;
}

interface PersonCredit {
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

interface CastMember extends PersonCredit {
	character: string;
	order: number;
	cast_id?: number;
}

interface CrewMember extends PersonCredit {
	department: string;
	job: string;
}

interface TMDBCredits {
	cast: CastMember[];
	crew: CrewMember[];
}

interface TMDBMediaBase {
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

interface TMDBMovieDetails extends TMDBMediaBase {
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

interface TMDBTVCreator {
	id: number;
	credit_id: string;
	name: string;
	original_name: string;
	gender: number;
	profile_path: string | null;
}

interface TMDBEpisode {
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

interface TMDBNetwork {
	id: number;
	logo_path: string | null;
	name: string;
	origin_country: string;
}

interface TMDBSeason {
	air_date: string | null;
	episode_count: number;
	id: number;
	name: string;
	overview: string | null;
	poster_path: string | null;
	season_number: number;
	vote_average: number;
}

interface TMDBTVDetails extends TMDBMediaBase {
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
}

// Normalized output types (camelCase)
interface NormalizedGenre {
	id: number;
	name: string;
}

interface NormalizedProductionCompany {
	id: number;
	logoPath: string | null;
	name: string;
	originCountry: string;
}

interface NormalizedProductionCountry {
	iso31661: string;
	name: string;
}

interface NormalizedSpokenLanguage {
	englishName: string;
	iso6391: string;
	name: string;
}

interface NormalizedCastMember {
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

interface NormalizedCrewMember {
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

interface NormalizedCredits {
	cast: NormalizedCastMember[];
	crew: NormalizedCrewMember[];
}

interface NormalizedMediaBase {
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

interface NormalizedCreator {
	id: number;
	creditId: string;
	name: string;
	originalName: string;
	gender: number;
	profilePath: string | null;
}

interface NormalizedEpisode {
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

interface NormalizedNetwork {
	id: number;
	logoPath: string | null;
	name: string;
	originCountry: string;
}

interface NormalizedSeason {
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

/**
 * Formats an array of people into a display string of names.
 * - 1 person: "Name"
 * - 2 people: "Name1, Name2"
 * - 3+ people: "Name1, Name2..."
 */
function formatNames(people: { name?: string | null }[] | null): string {
	const validNames = people
		?.map((person) => person.name)
		.filter((name): name is string => !!name && name.trim() !== '');

	if (!validNames || validNames.length === 0) {
		return 'Unknown';
	}

	if (validNames.length > 2) {
		return validNames.slice(0, 2).join(', ') + '...';
	} else if (validNames.length === 2) {
		return validNames.join(', ');
	} else {
		return validNames[0] || 'Unknown';
	}
}

/**
 * Validates that the TMDB response has expected base structure.
 */
function validateTMDBResponse(data: unknown): data is TMDBMediaBase {
	if (!data || typeof data !== 'object') return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.id === 'number' &&
		typeof obj.adult === 'boolean' &&
		Array.isArray(obj.genres) &&
		obj.credits !== undefined
	);
}

/**
 * Normalizes cast member from TMDB to camelCase.
 */
function normalizeCastMember(cast: CastMember): NormalizedCastMember {
	return {
		adult: cast.adult,
		gender: cast.gender,
		id: cast.id,
		knownForDepartment: cast.known_for_department,
		name: cast.name,
		originalName: cast.original_name,
		popularity: cast.popularity,
		profilePath: cast.profile_path,
		character: cast.character,
		creditId: cast.credit_id,
		order: cast.order,
		castId: cast.cast_id
	};
}

/**
 * Normalizes crew member from TMDB to camelCase.
 */
function normalizeCrewMember(crew: CrewMember): NormalizedCrewMember {
	return {
		adult: crew.adult,
		gender: crew.gender,
		id: crew.id,
		knownForDepartment: crew.known_for_department,
		name: crew.name,
		originalName: crew.original_name,
		popularity: crew.popularity,
		profilePath: crew.profile_path,
		creditId: crew.credit_id,
		department: crew.department,
		job: crew.job
	};
}

/**
 * Normalizes movie details from TMDB response.
 */
function normalizeMovieDetails(data: TMDBMovieDetails): NormalizedMovieDetails {
	// Trim cast to 12 and filter crew to directors only
	const trimmedCast = data.credits.cast.slice(0, 12);
	const directors = data.credits.crew.filter((member) => member.job === 'Director');

	return {
		mediaType: 'movie',
		adult: data.adult,
		backdropPath: data.backdrop_path,
		belongsToCollection: data.belongs_to_collection
			? {
					id: data.belongs_to_collection.id,
					name: data.belongs_to_collection.name,
					posterPath: data.belongs_to_collection.poster_path,
					backdropPath: data.belongs_to_collection.backdrop_path
				}
			: null,
		budget: data.budget,
		credits: {
			cast: trimmedCast.map(normalizeCastMember),
			crew: directors.map(normalizeCrewMember)
		},
		director: formatNames(directors),
		directorList: directors.map(normalizeCrewMember),
		genres: data.genres,
		homepage: data.homepage,
		id: data.id,
		imdbId: data.imdb_id,
		originCountry: data.origin_country,
		originalLanguage: data.original_language,
		originalTitle: data.original_title,
		overview: data.overview,
		popularity: data.popularity,
		posterPath: data.poster_path,
		productionCompanies: data.production_companies.map((pc) => ({
			id: pc.id,
			logoPath: pc.logo_path,
			name: pc.name,
			originCountry: pc.origin_country
		})),
		productionCountries: data.production_countries.map((pc) => ({
			iso31661: pc.iso_3166_1,
			name: pc.name
		})),
		releaseDate: data.release_date,
		revenue: data.revenue,
		runtime: data.runtime,
		spokenLanguages: data.spoken_languages.map((sl) => ({
			englishName: sl.english_name,
			iso6391: sl.iso_639_1,
			name: sl.name
		})),
		status: data.status,
		tagline: data.tagline,
		title: data.title,
		video: data.video,
		voteAverage: data.vote_average,
		voteCount: data.vote_count
	};
}

/**
 * Normalizes TV details from TMDB response.
 */
function normalizeTVDetails(data: TMDBTVDetails): NormalizedTVDetails {
	// Trim cast to 12 and filter crew to directors only
	const trimmedCast = data.credits.cast.slice(0, 12);
	const directors = data.credits.crew.filter((member) => member.job === 'Director');

	const normalizeEpisode = (ep: TMDBEpisode | null): NormalizedEpisode | null => {
		if (!ep) return null;
		return {
			id: ep.id,
			name: ep.name,
			overview: ep.overview,
			voteAverage: ep.vote_average,
			voteCount: ep.vote_count,
			airDate: ep.air_date,
			episodeNumber: ep.episode_number,
			episodeType: ep.episode_type,
			productionCode: ep.production_code,
			runtime: ep.runtime,
			seasonNumber: ep.season_number,
			showId: ep.show_id,
			stillPath: ep.still_path
		};
	};

	return {
		mediaType: 'tv',
		adult: data.adult,
		backdropPath: data.backdrop_path,
		creator: formatNames(data.created_by),
		creatorList: data.created_by.map((c) => ({
			id: c.id,
			creditId: c.credit_id,
			name: c.name,
			originalName: c.original_name,
			gender: c.gender,
			profilePath: c.profile_path
		})),
		credits: {
			cast: trimmedCast.map(normalizeCastMember),
			crew: directors.map(normalizeCrewMember)
		},
		episodeRunTime: data.episode_run_time,
		genres: data.genres,
		homepage: data.homepage,
		id: data.id,
		inProduction: data.in_production,
		languages: data.languages,
		lastAirDate: data.last_air_date,
		lastEpisodeToAir: normalizeEpisode(data.last_episode_to_air),
		networks: data.networks.map((n) => ({
			id: n.id,
			logoPath: n.logo_path,
			name: n.name,
			originCountry: n.origin_country
		})),
		nextEpisodeToAir: normalizeEpisode(data.next_episode_to_air),
		numberOfEpisodes: data.number_of_episodes,
		numberOfSeasons: data.number_of_seasons,
		originCountry: data.origin_country,
		originalLanguage: data.original_language,
		originalTitle: data.original_name, // Normalized to match movie field name
		overview: data.overview,
		popularity: data.popularity,
		posterPath: data.poster_path,
		productionCompanies: data.production_companies.map((pc) => ({
			id: pc.id,
			logoPath: pc.logo_path,
			name: pc.name,
			originCountry: pc.origin_country
		})),
		productionCountries: data.production_countries.map((pc) => ({
			iso31661: pc.iso_3166_1,
			name: pc.name
		})),
		releaseDate: data.first_air_date, // Normalized to match movie field name
		seasons: data.seasons.map((s) => ({
			airDate: s.air_date,
			episodeCount: s.episode_count,
			id: s.id,
			name: s.name,
			overview: s.overview,
			posterPath: s.poster_path,
			seasonNumber: s.season_number,
			voteAverage: s.vote_average
		})),
		spokenLanguages: data.spoken_languages.map((sl) => ({
			englishName: sl.english_name,
			iso6391: sl.iso_639_1,
			name: sl.name
		})),
		status: data.status,
		tagline: data.tagline,
		title: data.name, // Normalized to match movie field name
		type: data.type,
		voteAverage: data.vote_average,
		voteCount: data.vote_count
	};
}

/**
 * Fetches media details from TMDB API.
 *
 * @param mediaType - Either "movie" or "tv"
 * @param id - TMDB media ID
 * @returns Normalized movie or TV details
 * @throws Error on missing token, API failure, or invalid response
 */
export async function fetchDetailsFromTMDB(
	mediaType: MediaType,
	id: number
): Promise<NormalizedMediaDetails> {
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const url = `https://api.themoviedb.org/3/${mediaType}/${id}?append_to_response=credits&language=en-US`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			accept: 'application/json',
			Authorization: `Bearer ${apiToken}`
		}
	});

	if (!response.ok) {
		let message = `TMDB API Error: ${response.status} ${response.statusText}`;
		try {
			const tmdbError = (await response.json()) as TMDBError;
			if (tmdbError?.status_message) {
				message = `TMDB API Error: ${tmdbError.status_code} – ${tmdbError.status_message}`;
			}
		} catch {
			// Non-JSON error body
		}
		throw new Error(message);
	}

	const rawData = await response.json();

	if (!validateTMDBResponse(rawData)) {
		throw new Error('Invalid response structure from TMDB API');
	}

	if (mediaType === 'movie') {
		return normalizeMovieDetails(rawData as TMDBMovieDetails);
	} else {
		return normalizeTVDetails(rawData as TMDBTVDetails);
	}
}
