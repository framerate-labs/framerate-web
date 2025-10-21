import { json } from '@sveltejs/kit';
import { searchMedia } from '$services/search';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, request }) => {
	const query = url.searchParams.get('q') || '';

	try {
		const results = await searchMedia(query, request.signal);
		return json(results);
	} catch (error) {
		console.error('Search error:', error);
		return json(
			{ error: error instanceof Error ? error.message : 'Search failed' },
			{ status: 500 }
		);
	}
};
