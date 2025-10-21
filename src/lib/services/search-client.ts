import type { Trending } from '$types/trending';

import { HttpError, toHttpError } from '$utils/http-error';

/**
 * Client-side wrapper for search API
 * Calls the SvelteKit server endpoint which keeps the API key secure
 */
export async function searchMediaClient(query: string, signal?: AbortSignal): Promise<Trending[]> {
	const trimmedQuery = query.trim();

	// Short-circuit empty queries
	if (trimmedQuery.length === 0) return [];

	try {
		const params = new URLSearchParams({ q: trimmedQuery });
		const response = await fetch(`/api/search?${params}`, { signal });

		if (!response.ok) {
			const error = await response.json();
			throw new HttpError(error.error || 'Search failed', response.status);
		}

		const results = await response.json();
		return results;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to perform search');
	}
}
