import { HttpError, toHttpError } from '$utils/http-error';

import { client } from './client-instance';

const actionsRoute = client.api.v1.actions;

type ReviewData = {
	mediaType: 'movie' | 'tv';
	mediaId: number;
	field: 'liked' | 'watched';
	value: boolean;
};

/**
 * Update a review interaction field for a media item.
 * Valid fields: `liked`, `watched`.
 */
export async function updateReview({
	mediaType,
	mediaId,
	field,
	value
}: ReviewData): Promise<void> {
	if (mediaType !== 'movie' && mediaType !== 'tv') {
		throw new HttpError(`Invalid mediaType: ${mediaType}`);
	}
	if (!Number.isFinite(mediaId) || mediaId <= 0) {
		throw new HttpError(`Invalid mediaId: ${mediaId}`);
	}
	if (field !== 'liked' && field !== 'watched') {
		throw new HttpError(`Invalid field: ${field}`);
	}

	try {
		const { error } = await actionsRoute.media.patch({
			mediaType,
			mediaId,
			field,
			value
		});

		if (error) throw toHttpError(error, 'Unable to update review');
		return;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Unable to update review');
	}
}

/**
 * Add a list action for the active user.
 * Valid fields: `like`, `save`.
 */
export async function addListAction(listId: number, field: 'like' | 'save'): Promise<void> {
	if (!Number.isFinite(listId) || listId <= 0) {
		throw new HttpError(`Invalid listId: ${listId}`);
	}
	if (field !== 'like' && field !== 'save') {
		throw new HttpError(`Invalid field: ${field}`);
	}

	try {
		const { error } = await actionsRoute.lists.put({ listId, field });
		if (error) throw toHttpError(error, 'Unable to add list action');
		return;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Unable to add list action');
	}
}

/**
 * Remove a list action for the active user.
 * Valid fields: `like`, `save`.
 */
export async function deleteListAction(listId: number, field: 'like' | 'save'): Promise<void> {
	if (!Number.isFinite(listId) || listId <= 0) {
		throw new HttpError(`Invalid listId: ${listId}`);
	}
	if (field !== 'like' && field !== 'save') {
		throw new HttpError(`Invalid field: ${field}`);
	}

	try {
		const { error } = await actionsRoute.lists.delete(
			{},
			{
				query: { listId, field }
			}
		);
		if (error) throw toHttpError(error, 'Unable to delete list action');
		return;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Unable to delete list action');
	}
}
