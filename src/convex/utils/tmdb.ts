import type { TMDBErrorPayload, TMDBFetchOptions } from '../types/tmdb/commonTypes';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';

function buildTMDBUrl(pathOrUrl: string, params?: TMDBFetchOptions['params']): string {
	const url = pathOrUrl.startsWith('http')
		? new URL(pathOrUrl)
		: new URL(pathOrUrl.startsWith('/') ? `${TMDB_API_BASE}${pathOrUrl}` : `${TMDB_API_BASE}/${pathOrUrl}`);

	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value === null || value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}

	return url.toString();
}

function formatTMDBErrorMessage(
	response: Response,
	payload: unknown
): string {
	const fallback = `TMDB API Error: ${response.status} ${response.statusText}`;
	if (!payload || typeof payload !== 'object') return fallback;

	const tmdbPayload = payload as TMDBErrorPayload;
	const statusMessage =
		typeof tmdbPayload.status_message === 'string'
			? tmdbPayload.status_message.trim()
			: '';
	if (statusMessage.length === 0) return fallback;

	const statusCode =
		typeof tmdbPayload.status_code === 'number'
			? tmdbPayload.status_code
			: response.status;
	return `TMDB API Error: ${statusCode} – ${statusMessage}`;
}

export async function fetchTMDBJson(
	pathOrUrl: string,
	options: TMDBFetchOptions = {}
): Promise<unknown> {
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const response = await fetch(buildTMDBUrl(pathOrUrl, options.params), {
		method: 'GET',
		headers: {
			accept: 'application/json',
			Authorization: `Bearer ${apiToken}`
		}
	});

	const rawBody = await response.text();
	let payload: unknown = null;
	if (rawBody.trim().length > 0) {
		try {
			payload = JSON.parse(rawBody);
		} catch {
			payload = null;
		}
	}

	if (!response.ok) {
		throw new Error(formatTMDBErrorMessage(response, payload));
	}

	if (payload === null) {
		throw new Error('Invalid JSON response from TMDB API');
	}

	return payload;
}
