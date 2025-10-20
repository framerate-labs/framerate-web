import type { Trending } from '$types/trending';

import { HttpError, toHttpError } from '$utils/http-error';

import { client } from './client-instance';

/**
 * Search for movies and TV shows.
 * Returns up to 10 results, filtered to exclude people.
 */
export async function searchMedia(query: string, signal?: AbortSignal): Promise<Trending[]> {
	const trimmedQuery = query.trim();

	// Short-circuit empty or too-long queries
	if (trimmedQuery.length === 0) return [];
	if (trimmedQuery.length > 100) {
		throw new HttpError('Query too long (max 100 characters)');
	}

	try {
		// Try to use the API client if search endpoint exists
		// For now, we'll need to implement a direct TMDB search
		// until the server has a search endpoint

		// This is a placeholder - you'll need to either:
		// 1. Add a search endpoint to the server
		// 2. Or make direct TMDB API calls from the client

		throw new HttpError('Search not yet implemented on server');
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to perform search');
	}
}
