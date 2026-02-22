/**
 * TMDB Details Service
 *
 * Handles fetching, validating, and normalizing movie/TV details from TMDB API.
 * Used by Convex actions to fetch media details on-demand.
 */

import type { MediaType } from '../types/mediaTypes';
import type {
	CastMember,
	CrewMember,
	NormalizedCastMember,
	NormalizedCrewMember,
	NormalizedMediaDetails,
	NormalizedMovieDetails,
	NormalizedTVDetails,
	TMDBEpisode,
	TMDBMediaBase,
	TMDBMovieDetails,
	TMDBTVDetails
} from '../types/tmdb/detailsTypes';

import { fetchTMDBJson } from '../utils/tmdb';

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
	const castMembers = data.credits.cast;
	const crewMembers = data.credits.crew;
	const directors = crewMembers.filter((member) => member.job === 'Director');

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
			cast: castMembers.map(normalizeCastMember),
			crew: crewMembers.map(normalizeCrewMember)
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
	const castMembers = data.credits.cast;
	const crewMembers = data.credits.crew;

	const normalizeEpisode = (ep: TMDBEpisode | null) => {
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
			cast: castMembers.map(normalizeCastMember),
			crew: crewMembers.map(normalizeCrewMember)
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
		originalTitle: data.original_name,
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
		releaseDate: data.first_air_date,
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
		title: data.name,
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
	const rawData = await fetchTMDBJson(`/${mediaType}/${id}`, {
		params: {
			append_to_response: 'credits',
			language: 'en-US'
		}
	});

	if (!validateTMDBResponse(rawData)) {
		throw new Error('Invalid response structure from TMDB API');
	}

	if (mediaType === 'movie') {
		return normalizeMovieDetails(rawData as TMDBMovieDetails);
	} else {
		return normalizeTVDetails(rawData as TMDBTVDetails);
	}
}
