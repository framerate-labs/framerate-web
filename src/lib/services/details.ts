import type { MediaDetails } from '$types/details';

import { HttpError, toHttpError, unwrapData } from '$utils/http-error';

import { client } from './client-instance';

const VALID_MEDIA = ['movie', 'tv', 'person'] as const;
type MediaType = (typeof VALID_MEDIA)[number];

function isDigits(value: string): boolean {
	return /^\d+$/.test(value);
}

/**
 * Fetch full media details by type and TMDB id.
 *
 * Example
 * ```ts
 * const details = await getDetails('movie', '603');
 * ```
 */
export async function getDetails<T extends MediaType>(
	mediaType: T,
	id: string
): Promise<MediaDetails<T>> {
	if (!VALID_MEDIA.includes(mediaType)) {
		throw new HttpError(`Invalid mediaType: ${mediaType}`);
	}
	if (!id || !isDigits(id)) {
		throw new HttpError(`Invalid id: ${id}`);
	}

	try {
		const detailsRoute = client.api.v1.details({ type: mediaType })({ id });
		const { data, error } = await detailsRoute.get();

		if (error) {
			throw toHttpError(error, 'Unable to load details');
		}

		const details = unwrapData<MediaDetails<T>>(data);
		return details;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to fetch details');
	}
}
