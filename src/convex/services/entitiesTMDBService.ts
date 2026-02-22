import type {
	MediaWork,
	MediaWorkType,
	TMDBCompanyDetailsResponse,
	TMDBDiscoverResponse,
	TMDBPersonDetailsResponse
} from '../types/entitiesTypes';

import { fetchTMDBJson } from '../utils/tmdb';
import { dedupeMediaWorks, sortMediaWorksByDateThenTitle } from './entitiesMediaWorkService';

export function parseTMDBDiscoverResponse(value: unknown): {
	items: Array<{
		id: number;
		title: string | null;
		posterPath: string | null;
		releaseDate: string | null;
	}>;
	totalPages: number;
} {
	if (!value || typeof value !== 'object') {
		throw new Error('Invalid response structure from TMDB discover API');
	}

	const payload = value as TMDBDiscoverResponse;
	const results = Array.isArray(payload.results) ? payload.results : [];
	const items = results
		.map((result) => {
			if (!result || typeof result.id !== 'number') return null;
			const titleCandidate =
				typeof result.title === 'string'
					? result.title
					: typeof result.name === 'string'
						? result.name
						: null;

			return {
				id: result.id,
				title: titleCandidate?.trim() ? titleCandidate.trim() : null,
				posterPath: typeof result.poster_path === 'string' ? result.poster_path : null,
				releaseDate:
					typeof result.release_date === 'string'
						? result.release_date
						: typeof result.first_air_date === 'string'
							? result.first_air_date
							: null
			};
		})
		.filter(
			(
				item
			): item is {
				id: number;
				title: string | null;
				posterPath: string | null;
				releaseDate: string | null;
			} => item !== null
		);

	const totalPages =
		typeof payload.total_pages === 'number' && payload.total_pages > 0
			? Math.floor(payload.total_pages)
			: 1;

	return { items, totalPages };
}

export async function fetchCompanyMediaWorksFromTMDB(
	tmdbCompanyId: number,
	mediaType: MediaWorkType,
	maxPages: number
): Promise<MediaWork[]> {
	const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
	const rows: MediaWork[] = [];
	let page = 1;
	let totalPages = 1;
	const safeMaxPages = Math.max(1, maxPages);

	while (page <= totalPages && page <= safeMaxPages) {
		const parsed = parseTMDBDiscoverResponse(
			await fetchTMDBJson(`/discover/${endpoint}`, {
				params: {
					language: 'en-US',
					with_companies: tmdbCompanyId,
					sort_by: 'popularity.desc',
					page
				}
			})
		);
		totalPages = Math.min(safeMaxPages, parsed.totalPages);
		for (let index = 0; index < parsed.items.length; index += 1) {
			const item = parsed.items[index];
			if (!item || !item.title) continue;
			rows.push({
				mediaType,
				tmdbId: item.id,
				title: item.title,
				posterPath: item.posterPath,
				releaseDate: item.releaseDate,
				role: 'production',
				billingOrder: (page - 1) * 100 + index
			});
		}
		page += 1;
	}

	return dedupeMediaWorks(rows).sort(sortMediaWorksByDateThenTitle);
}

export async function fetchPersonFromTMDB(
	tmdbPersonId: number
): Promise<TMDBPersonDetailsResponse> {
	const payload = (await fetchTMDBJson(`/person/${tmdbPersonId}`, {
		params: {
			append_to_response: 'combined_credits',
			language: 'en-US'
		}
	})) as TMDBPersonDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB person API');
	}

	return payload;
}

export async function fetchCompanyFromTMDB(
	tmdbCompanyId: number
): Promise<TMDBCompanyDetailsResponse> {
	const payload = (await fetchTMDBJson(`/company/${tmdbCompanyId}`)) as TMDBCompanyDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB company API');
	}
	return payload;
}
