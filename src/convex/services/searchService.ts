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

function deriveReleaseYear(releaseDate: string | null): number | null {
	if (!releaseDate) return null;
	const match = /^(\d{4})/.exec(releaseDate);
	if (!match) return null;
	const year = Number(match[1]);
	return Number.isFinite(year) ? year : null;
}

function hasTextValue(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function shouldDropMediaResult(item: TMDBSearchItem): boolean {
	if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;

	// TMDB multi-search doesn't provide last/next air dates for TV rows.
	// We use first_air_date as the only available date signal at this stage.
	const hasAnyDateSignal =
		item.media_type === 'movie'
			? hasTextValue(item.release_date)
			: hasTextValue(item.first_air_date);
	const hasPoster = hasTextValue(item.poster_path);
	const hasBackdrop = hasTextValue(item.backdrop_path);

	return !hasAnyDateSignal && !hasPoster && !hasBackdrop;
}

function personHasKnownForCredits(item: TMDBSearchItem): boolean {
	if (item.media_type !== 'person') return true;
	const knownFor = item.known_for;
	if (!Array.isArray(knownFor) || knownFor.length === 0) return false;
	return knownFor.some((credit) => {
		if (!credit) return false;
		const isSupportedMediaType = credit.media_type === 'movie' || credit.media_type === 'tv';
		if (!isSupportedMediaType) return false;
		if (typeof credit.id !== 'number') return false;
		return hasTextValue(credit.title) || hasTextValue(credit.name);
	});
}

function normalizeItem(item: TMDBSearchItem): NormalizedSearchItem | null {
	if (item.media_type !== 'movie' && item.media_type !== 'tv' && item.media_type !== 'person') {
		return null;
	}
	if (shouldDropMediaResult(item)) return null;
	if (!personHasKnownForCredits(item)) return null;

	const title = item.media_type === 'movie' ? item.title : item.name;
	const originalTitle = item.media_type === 'movie' ? item.original_title : item.original_name;
	const releaseDate =
		item.media_type === 'movie'
			? item.release_date
			: item.media_type === 'tv'
				? item.first_air_date
				: null;
	const posterPathRaw =
		item.media_type === 'person' ? (item.profile_path ?? item.poster_path) : item.poster_path;
	const posterPath = posterPathRaw ?? null;
	const knownForDepartment =
		item.media_type === 'person' ? (item.known_for_department ?? null) : null;
	const releaseYear = deriveReleaseYear(releaseDate ?? null);

	return {
		id: item.id,
		mediaType: item.media_type,
		title: title ?? originalTitle ?? 'Unknown',
		originalTitle: originalTitle ?? title ?? 'Unknown',
		overview: item.overview,
		posterPath,
		knownForDepartment,
		releaseYear,
		backdropPath: item.backdrop_path,
		popularity: item.popularity,
		releaseDate: releaseDate ?? null,
		voteAverage: item.vote_average ?? null,
		voteCount: item.vote_count ?? null,
		adult: item.adult
	};
}

function prioritizeImageBackedResults(items: NormalizedSearchItem[]): NormalizedSearchItem[] {
	const withImage: NormalizedSearchItem[] = [];
	const withoutImage: NormalizedSearchItem[] = [];

	for (const item of items) {
		if (item.posterPath) {
			withImage.push(item);
		} else {
			withoutImage.push(item);
		}
	}

	return [...withImage, ...withoutImage];
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

	const normalized = rawData.results
		.map(normalizeItem)
		.filter((item): item is NormalizedSearchItem => item !== null);

	return prioritizeImageBackedResults(normalized).slice(0, limit);
}
