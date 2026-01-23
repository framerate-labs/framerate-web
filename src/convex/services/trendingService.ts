/**
 * TMDB Trending Service
 *
 * Handles fetching, validating, and normalizing trending data from TMDB API.
 * Used by Convex actions to populate the trendingCache table.
 */

export type TimeWindow = 'day' | 'week';
export type Filter = 'all' | 'movie' | 'tv' | 'person';

type TMDBError = {
	success: boolean;
	status_code: number;
	status_message: string;
};

// Raw TMDB response types (snake_case)
interface TMDBMediaBase {
	adult: boolean;
	backdrop_path: string | null;
	genre_ids: number[];
	id: number;
	original_language: string;
	overview: string;
	popularity: number;
	poster_path: string | null;
	vote_average: number;
	vote_count: number;
}

interface TMDBMovie extends TMDBMediaBase {
	media_type: 'movie';
	original_title: string;
	release_date: string;
	title: string;
	video: boolean;
}

interface TMDBTVShow extends TMDBMediaBase {
	media_type: 'tv';
	first_air_date: string;
	name: string;
	origin_country: string[];
	original_name: string;
}

interface TMDBPerson {
	adult: boolean;
	gender: number;
	id: number;
	known_for_department: string | null;
	media_type: 'person';
	name: string;
	original_name: string;
	popularity: number;
	profile_path: string | null;
}

type TMDBTrendingItem = TMDBMovie | TMDBTVShow | TMDBPerson;

interface TMDBTrendingResponse {
	page: number;
	results: TMDBTrendingItem[];
	total_pages: number;
	total_results: number;
}

// Normalized output type (camelCase, consistent shape)
export interface NormalizedTrendingItem {
	id: number;
	mediaType: 'movie' | 'tv' | 'person';
	title: string;
	originalTitle: string;
	overview?: string;
	posterPath: string | null;
	backdropPath: string | null;
	popularity: number;
	voteAverage?: number;
	voteCount?: number;
	releaseDate?: string;
	genreIds?: number[];
	adult: boolean;
	// Person-specific
	profilePath?: string | null;
	knownForDepartment?: string | null;
}

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
			title: item.name, // Normalize to "title"
			originalTitle: item.original_name,
			overview: item.overview,
			posterPath: item.poster_path,
			backdropPath: item.backdrop_path,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			releaseDate: item.first_air_date, // Normalize to "releaseDate"
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
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const url = `https://api.themoviedb.org/3/trending/${filter}/${timeWindow}?language=en-US`;

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

	// Normalize and limit results
	return rawData.results.slice(0, limit).map(normalizeItem);
}
