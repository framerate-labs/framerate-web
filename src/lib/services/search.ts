import type { SearchResults } from '$types/search';
import type { Trending } from '$types/trending';

import { HttpError, toHttpError } from '$utils/http-error';
import { normalizeSearchResult } from '$utils/normalize-search';

import { TMDB_API_TOKEN } from '$env/static/private';

/**
 * Search TMDB for movies and TV shows.
 * - Filters out people results client-side.
 * - Uses TMDB API directly from the client.
 */
export async function searchMedia(query: string, signal?: AbortSignal): Promise<Trending[]> {
	const trimmedQuery = query.trim();

	// Short-circuit empty or too-long queries to avoid wasted requests
	if (trimmedQuery.length === 0) return [];
	if (trimmedQuery.length > 100) {
		throw new HttpError('Query too long (max 100 characters)');
	}

	const API_TOKEN = TMDB_API_TOKEN;
	if (!API_TOKEN) {
		throw new HttpError('API configuration missing');
	}

	const params = new URLSearchParams({
		query: trimmedQuery,
		include_adult: 'false',
		language: 'en-US',
		page: '1'
	});

	const url = `https://api.themoviedb.org/3/search/multi?${params}`;

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				Authorization: `Bearer ${API_TOKEN}`
			},
			signal
		});

		if (!response.ok) {
			if (response.status === 429) {
				throw new HttpError('TMDB rate limit exceeded. Try again later.', 429);
			}
			let message = 'Search request failed';
			try {
				const body = (await response.json()) as { status_message?: string };
				if (body?.status_message) message = body.status_message;
			} catch {
				// ignore JSON parsing errors
			}
			throw new HttpError(message, response.status);
		}

		const rawData = (await response.json()) as SearchResults;

		// Filter out people
		const searchResults = rawData.results
			.filter((item) => item.media_type !== 'person')
			.slice(0, 10)
			.map(normalizeSearchResult);

		return searchResults;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to perform search');
	}
}
