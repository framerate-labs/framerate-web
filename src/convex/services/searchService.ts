/**
 * TMDB Search Service
 *
 * Handles fetching, validating, and normalizing TMDB multi-search results.
 */

interface TMDBError {
	success?: boolean;
	status_code?: number;
	status_message?: string;
}

interface TMDBSearchItem {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	overview?: string;
	poster_path: string | null;
	backdrop_path: string | null;
	popularity: number;
	release_date?: string;
	first_air_date?: string;
	vote_average?: number;
	vote_count?: number;
	adult: boolean;
}

interface TMDBSearchResponse {
	results: TMDBSearchItem[];
}

export interface NormalizedSearchItem {
	id: number;
	mediaType: 'movie' | 'tv';
	title: string;
	originalTitle: string;
	overview?: string;
	posterPath: string | null;
	backdropPath: string | null;
	popularity: number;
	releaseDate: string | null;
	voteAverage: number | null;
	voteCount: number | null;
	adult: boolean;
}

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
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const params = new URLSearchParams({
		query,
		include_adult: 'false',
		language: 'en-US',
		page: '1'
	});

	const response = await fetch(`https://api.themoviedb.org/3/search/multi?${params}`, {
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
				message = `TMDB API Error: ${tmdbError.status_code ?? response.status} – ${tmdbError.status_message}`;
			}
		} catch {
			// Non-JSON error body
		}
		throw new Error(message);
	}

	const rawData = await response.json();
	if (!isSearchResponse(rawData)) {
		throw new Error('Invalid response structure from TMDB search API');
	}

	return rawData.results
		.map(normalizeItem)
		.filter((item): item is NormalizedSearchItem => item !== null)
		.slice(0, limit);
}
