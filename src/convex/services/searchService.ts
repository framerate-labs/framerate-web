/**
 * TMDB Search Service
 *
 * Handles fetching, validating, and normalizing TMDB multi-search results.
 */

import type {
	NormalizedSearchItem,
	TMDBSearchItem,
	TMDBSearchResponse
} from '../types/tmdb/searchTypes';

import { fetchTMDBJson } from '../utils/tmdb';

function isSearchResponse(value: unknown): value is TMDBSearchResponse {
	if (!value || typeof value !== 'object') return false;
	const obj = value as Record<string, unknown>;
	return Array.isArray(obj.results);
}

function normalizeItem(item: TMDBSearchItem): NormalizedSearchItem | null {
	if (item.media_type === 'person') return null;

	const title = item.media_type === 'movie' ? item.title : item.name;
	const originalTitle = item.media_type === 'movie' ? item.original_title : item.original_name;
	const releaseDate = item.media_type === 'movie' ? item.release_date : item.first_air_date;

	return {
		id: item.id,
		mediaType: item.media_type,
		title: title ?? originalTitle ?? 'Unknown',
		originalTitle: originalTitle ?? title ?? 'Unknown',
		overview: item.overview,
		posterPath: item.poster_path,
		backdropPath: item.backdrop_path,
		popularity: item.popularity,
		releaseDate: releaseDate ?? null,
		voteAverage: item.vote_average ?? null,
		voteCount: item.vote_count ?? null,
		adult: item.adult
	};
}

/**
 * Fetch search results from TMDB multi-search endpoint.
 */
export async function fetchSearchFromTMDB(
	query: string,
	limit: number = 10
): Promise<NormalizedSearchItem[]> {
	const rawData = await fetchTMDBJson('/search/multi', {
		params: {
			query,
			include_adult: false,
			language: 'en-US',
			page: 1
		}
	});
	if (!isSearchResponse(rawData)) {
		throw new Error('Invalid response structure from TMDB search API');
	}

	return rawData.results
		.map(normalizeItem)
		.filter((item): item is NormalizedSearchItem => item !== null)
		.slice(0, limit);
}
