/**
 * TMDB Details Service
 *
 * Handles fetching, validating, and normalizing movie/TV details from TMDB API.
 * Used by Convex actions to fetch media details on-demand.
 */

import type { MediaType } from '../types/mediaTypes';
import type {
	AggregateCastMember,
	AggregateCrewMember,
	CastMember,
	CrewMember,
	NormalizedCredits,
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

const TMDB_PREVIEW_CREDITS_LIMIT = 10;

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
	return typeof obj.id === 'number' && typeof obj.adult === 'boolean' && Array.isArray(obj.genres);
}

/**
 * Normalizes cast member from TMDB to camelCase.
 */
export function normalizeCastMember(cast: CastMember): NormalizedCastMember {
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
export function normalizeCrewMember(crew: CrewMember): NormalizedCrewMember {
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

function normalizedText(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function pickPrimaryAggregateCastRole(member: AggregateCastMember) {
	const roles = Array.isArray(member.roles) ? member.roles : [];
	if (roles.length === 0) return null;
	return [...roles].sort((left, right) => {
		const episodeDelta = (right.episode_count ?? 0) - (left.episode_count ?? 0);
		if (episodeDelta !== 0) return episodeDelta;
		const leftCharacter = normalizedText(left.character);
		const rightCharacter = normalizedText(right.character);
		return leftCharacter.localeCompare(rightCharacter);
	})[0];
}

function pickPrimaryAggregateCrewJob(member: AggregateCrewMember) {
	const jobs = Array.isArray(member.jobs) ? member.jobs : [];
	if (jobs.length === 0) return null;
	return [...jobs].sort((left, right) => {
		const episodeDelta = (right.episode_count ?? 0) - (left.episode_count ?? 0);
		if (episodeDelta !== 0) return episodeDelta;
		const leftDepartment = normalizedText(left.department);
		const rightDepartment = normalizedText(right.department);
		const departmentDelta = leftDepartment.localeCompare(rightDepartment);
		if (departmentDelta !== 0) return departmentDelta;
		const leftJob = normalizedText(left.job);
		const rightJob = normalizedText(right.job);
		return leftJob.localeCompare(rightJob);
	})[0];
}

export function normalizeAggregateCastMember(
	member: AggregateCastMember
): NormalizedCastMember | null {
	const role = pickPrimaryAggregateCastRole(member);
	if (!role) return null;
	const character = normalizedText(role.character);
	const creditId = normalizedText(role.credit_id);
	const knownForDepartment = normalizedText(member.known_for_department);
	return {
		adult: member.adult,
		gender: member.gender,
		id: member.id,
		knownForDepartment: knownForDepartment.length > 0 ? knownForDepartment : 'Character',
		name: member.name,
		originalName: member.original_name,
		popularity: member.popularity,
		profilePath: member.profile_path,
		character: character.length > 0 ? character : 'Character',
		creditId: creditId.length > 0 ? creditId : `aggregate:cast:${member.id}:${member.order}`,
		order: member.order,
		castId: undefined
	};
}

export function normalizeAggregateCrewMember(
	member: AggregateCrewMember
): NormalizedCrewMember | null {
	const job = pickPrimaryAggregateCrewJob(member);
	if (!job) return null;
	const creditId = normalizedText(job.credit_id);
	const department = normalizedText(job.department);
	const normalizedJob = normalizedText(job.job);
	const knownForDepartment = normalizedText(member.known_for_department);
	return {
		adult: member.adult,
		gender: member.gender,
		id: member.id,
		knownForDepartment: knownForDepartment.length > 0 ? knownForDepartment : 'Production',
		name: member.name,
		originalName: member.original_name,
		popularity: member.popularity,
		profilePath: member.profile_path,
		creditId: creditId.length > 0 ? creditId : `aggregate:crew:${member.id}:${normalizedJob || 'crew'}`,
		department: department.length > 0 ? department : 'Production',
		job: normalizedJob.length > 0 ? normalizedJob : 'Crew'
	};
}

/**
 * Normalizes movie details from TMDB response.
 */
function normalizeMovieDetails(data: TMDBMovieDetails): NormalizedMovieDetails {
	const castMembers = Array.isArray(data.credits?.cast) ? data.credits.cast : [];
	const crewMembers = Array.isArray(data.credits?.crew) ? data.credits.crew : [];
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
	const aggregateCastMembers = (Array.isArray(data.aggregate_credits?.cast) ? data.aggregate_credits?.cast : [])
		.map(normalizeAggregateCastMember)
		.filter((member): member is NormalizedCastMember => member !== null);
	const aggregateCrewMembers = (Array.isArray(data.aggregate_credits?.crew) ? data.aggregate_credits?.crew : [])
		.map(normalizeAggregateCrewMember)
		.filter((member): member is NormalizedCrewMember => member !== null);
	const normalizedCastMembers =
		aggregateCastMembers.length > 0
			? aggregateCastMembers
			: (Array.isArray(data.credits?.cast) ? data.credits.cast : []).map(normalizeCastMember);
	const normalizedCrewMembers =
		aggregateCrewMembers.length > 0
			? aggregateCrewMembers
			: (Array.isArray(data.credits?.crew) ? data.credits.crew : []).map(normalizeCrewMember);

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
			cast: normalizedCastMembers,
			crew: normalizedCrewMembers
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

function normalizeMovieCreditsPayload(raw: unknown): NormalizedCredits {
	if (!raw || typeof raw !== 'object') {
		return { cast: [], crew: [] };
	}
	const payload = raw as {
		cast?: CastMember[];
		crew?: CrewMember[];
	};
	return {
		cast: (Array.isArray(payload.cast) ? payload.cast : []).map(normalizeCastMember),
		crew: (Array.isArray(payload.crew) ? payload.crew : []).map(normalizeCrewMember)
	};
}

function normalizeTVAggregateCreditsPayload(raw: unknown): NormalizedCredits {
	if (!raw || typeof raw !== 'object') {
		return { cast: [], crew: [] };
	}
	const payload = raw as {
		cast?: AggregateCastMember[];
		crew?: AggregateCrewMember[];
	};
	return {
		cast: (Array.isArray(payload.cast) ? payload.cast : [])
			.map(normalizeAggregateCastMember)
			.filter((member): member is NormalizedCastMember => member !== null),
		crew: (Array.isArray(payload.crew) ? payload.crew : [])
			.map(normalizeAggregateCrewMember)
			.filter((member): member is NormalizedCrewMember => member !== null)
	};
}

export async function fetchCreditsFromTMDB(
	mediaType: MediaType,
	id: number,
	targetCoverage: 'preview' | 'full' = 'full',
	options?: { seasonNumber?: number | null }
): Promise<{
	coverage: 'preview' | 'full';
	cast: NormalizedCastMember[];
	crew: NormalizedCrewMember[];
	castTotal: number;
	crewTotal: number;
}> {
	const normalizedSeasonNumber =
		mediaType === 'tv' &&
		typeof options?.seasonNumber === 'number' &&
		Number.isFinite(options.seasonNumber)
			? Math.floor(options.seasonNumber)
			: null;

	let normalized: NormalizedCredits;
	if (mediaType === 'movie') {
		const raw = await fetchTMDBJson(`/movie/${id}/credits`, { params: { language: 'en-US' } });
		normalized = normalizeMovieCreditsPayload(raw);
	} else if (normalizedSeasonNumber != null && normalizedSeasonNumber >= 0) {
		try {
			const rawAggregate = await fetchTMDBJson(`/tv/${id}/season/${normalizedSeasonNumber}/aggregate_credits`, {
				params: { language: 'en-US' }
			});
			const aggregateCredits = normalizeTVAggregateCreditsPayload(rawAggregate);
			if (aggregateCredits.cast.length > 0 || aggregateCredits.crew.length > 0) {
				normalized = aggregateCredits;
			} else {
				const rawSeason = await fetchTMDBJson(`/tv/${id}/season/${normalizedSeasonNumber}/credits`, {
					params: { language: 'en-US' }
				});
				normalized = normalizeMovieCreditsPayload(rawSeason);
			}
		} catch {
			const fallbackRaw = await fetchTMDBJson(`/tv/${id}/aggregate_credits`, {
				params: { language: 'en-US' }
			});
			normalized = normalizeTVAggregateCreditsPayload(fallbackRaw);
		}
	} else {
		const raw = await fetchTMDBJson(`/tv/${id}/aggregate_credits`, { params: { language: 'en-US' } });
		normalized = normalizeTVAggregateCreditsPayload(raw);
	}

	const castTotal = normalized.cast.length;
	const crewTotal = normalized.crew.length;
	if (targetCoverage === 'full') {
		return {
			coverage: 'full',
			cast: normalized.cast,
			crew: normalized.crew,
			castTotal,
			crewTotal
		};
	}
	const hasMore = castTotal > TMDB_PREVIEW_CREDITS_LIMIT || crewTotal > TMDB_PREVIEW_CREDITS_LIMIT;
	return {
		coverage: hasMore ? 'preview' : 'full',
		cast: hasMore ? normalized.cast.slice(0, TMDB_PREVIEW_CREDITS_LIMIT) : normalized.cast,
		crew: hasMore ? normalized.crew.slice(0, TMDB_PREVIEW_CREDITS_LIMIT) : normalized.crew,
		castTotal,
		crewTotal
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
	id: number,
	options?: { includeCredits?: boolean }
): Promise<NormalizedMediaDetails> {
	const includeCredits = options?.includeCredits === true;
	const appendToResponse = (() => {
		if (!includeCredits) return undefined;
		return mediaType === 'tv' ? 'credits,aggregate_credits' : 'credits';
	})();
	const rawData = await fetchTMDBJson(`/${mediaType}/${id}`, {
		params: {
			append_to_response: appendToResponse,
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
