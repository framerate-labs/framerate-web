/**
 * TMDB Trending Service
 *
 * Handles fetching, validating, and normalizing trending data from TMDB API.
 * Used by Convex actions to populate the trendingCache table.
 */

import type {
	Filter,
	NormalizedTrendingItem,
	TimeWindow,
	TMDBTrendingItem,
	TMDBTrendingResponse
} from '../types/tmdb/trendingTypes';

import { fetchTMDBJson } from '../utils/tmdb';

/**
 * Validates TMDB response has expected structure.
 * Lightweight runtime check - we trust TMDB but guard against breaking changes.
 */
function validateTMDBResponse(data: unknown): data is TMDBTrendingResponse {
	if (!data || typeof data !== 'object') return false;
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.page === 'number' &&
		Array.isArray(obj.results) &&
		typeof obj.total_pages === 'number' &&
		typeof obj.total_results === 'number'
	);
}

/**
 * Normalizes a TMDB trending item to a consistent shape.
 * - Converts snake_case to camelCase
 * - Maps TV show fields (name -> title, firstAirDate -> releaseDate)
 * - Maps person fields to common shape
 */
function normalizeItem(item: TMDBTrendingItem): NormalizedTrendingItem {
	const base = {
		id: item.id,
		mediaType: item.media_type,
		adult: item.adult,
		popularity: item.popularity
	};

	if (item.media_type === 'movie') {
		return {
			...base,
			mediaType: 'movie',
			title: item.title,
			originalTitle: item.original_title,
			overview: item.overview,
			posterPath: item.poster_path,
			backdropPath: item.backdrop_path,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			releaseDate: item.release_date,
			genreIds: item.genre_ids
		};
	}

	if (item.media_type === 'tv') {
		return {
			...base,
			mediaType: 'tv',
			title: item.name,
			originalTitle: item.original_name,
			overview: item.overview,
			posterPath: item.poster_path,
			backdropPath: item.backdrop_path,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			releaseDate: item.first_air_date,
			genreIds: item.genre_ids
		};
	}

	// Person
	return {
		...base,
		mediaType: 'person',
		title: item.name,
		originalTitle: item.original_name,
		posterPath: null,
		backdropPath: null,
		profilePath: item.profile_path,
		knownForDepartment: item.known_for_department
	};
}

/**
 * Fetches trending media from TMDB API.
 *
 * @param filter - Media type filter: "all" | "movie" | "tv" | "person"
 * @param timeWindow - Time window: "day" | "week"
 * @param limit - Max items to return (default 18)
 * @returns Array of normalized trending items
 * @throws Error on missing token, API failure, or invalid response
 */
export async function fetchTrendingFromTMDB(
	filter: Filter,
	timeWindow: TimeWindow,
	limit: number = 18
): Promise<NormalizedTrendingItem[]> {
	const rawData = await fetchTMDBJson(`/trending/${filter}/${timeWindow}`, {
		params: {
			language: 'en-US'
		}
	});

	if (!validateTMDBResponse(rawData)) {
		throw new Error('Invalid response structure from TMDB API');
	}

	return rawData.results.slice(0, limit).map(normalizeItem);
}
