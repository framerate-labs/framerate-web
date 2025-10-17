import type { Trending } from '$types/trending';

import { HttpError, toHttpError, unwrapData } from '$utils/http-error';

import { client } from './client-instance';

type MediaFilter = 'all' | 'movie' | 'tv' | 'person';
type TimeWindow = 'day' | 'week';

type GetTrendingParams<T extends MediaFilter> = {
	filter: T;
	timeWindow: TimeWindow;
};

const VALID_FILTERS: readonly MediaFilter[] = ['all', 'movie', 'tv', 'person'] as const;
const VALID_WINDOWS: readonly TimeWindow[] = ['day', 'week'] as const;

/**
 * Fetch trending media for the given filter and time window.
 * - Valid filters: `all`, `movie`, `tv`, `person`.
 * - Valid windows: `day`, `week`.
 *
 * Example
 * ```ts
 * const items = await getTrending({ filter: 'movie', timeWindow: 'day' });
 * ```
 */
export async function getTrending<T extends MediaFilter>({
	filter,
	timeWindow
}: GetTrendingParams<T>): Promise<Trending<T>[]> {
	// Runtime validation to fail fast on invalid inputs
	if (!VALID_FILTERS.includes(filter)) {
		throw new HttpError(`Invalid filter: ${filter}`);
	}
	if (!VALID_WINDOWS.includes(timeWindow)) {
		throw new HttpError(`Invalid timeWindow: ${timeWindow}`);
	}

	try {
		const { data, error } = await client.api.v1.trending.get({
			query: { filter, timeWindow }
		});

		if (error) {
			throw toHttpError(error, 'Unable to load trending');
		}

		const items = unwrapData<Trending<T>[]>(data);
		return items;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to fetch trending');
	}
}
