import type { List, PopularList } from '$lib/types/lists';

import { HttpError, toHttpError, unwrapData } from '$lib/utils/http-error';

import { client } from './client-instance';

type InsertListItem = {
	listId: number;
	mediaType: 'movie' | 'tv';
	mediaId: number;
};

type ListUpdates = {
	name: string;
};

const listsRoute = client.api.v1.lists;
const listItemsRoute = client.api.v1['list-items'];

export type ListPageData = {
	list: List;
	isLiked: boolean;
	isSaved: boolean;
	listItems: Array<{
		mediaType: 'movie' | 'tv';
		listId: number;
		mediaId: number;
		listItemId: number;
		title: string;
		posterPath: string | null;
		createdAt: Date;
	}>;
};

export type SavedListItem = {
	listId: number;
	listItemId: number;
	mediaType: 'movie' | 'tv';
	mediaId: number | null;
} | null;

export type AddListItemResult = {
	created: boolean;
	item: {
		id: number;
		listId: number;
		mediaType: 'movie' | 'tv';
		movieId: number | null;
		seriesId: number | null;
	};
};

/**
 * Create a new list for the active user.
 */
export async function createList(listName: string): Promise<List> {
	if (typeof listName !== 'string' || listName.trim().length < 1) {
		throw new HttpError('List name is required');
	}
	const safeName = listName.trim().slice(0, 100);

	try {
		const { data, error } = await listsRoute.post({ listName: safeName });
		if (error) throw toHttpError(error, 'Unable to create list');
		return unwrapData<List>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to create list');
	}
}

/**
 * Fetch all lists for the active user.
 */
export async function getLists(): Promise<List[]> {
	try {
		const { data, error } = await listsRoute.get();
		if (error) throw toHttpError(error, 'Unable to load lists');
		return unwrapData<List[]>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to load lists');
	}
}

/**
 * Update list metadata (name).
 */
export async function updateList(listId: number, updates: ListUpdates): Promise<List> {
	if (!Number.isFinite(listId) || listId <= 0) {
		throw new HttpError(`Invalid listId: ${listId}`);
	}
	const name = updates?.name?.trim?.();
	if (!name) {
		throw new HttpError('List name is required');
	}

	try {
		const { data, error } = await listsRoute({ listId }).patch({
			listName: name
		});
		if (error) throw toHttpError(error, 'Unable to update list');
		return unwrapData<List>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to update list');
	}
}

/**
 * Delete a list by id.
 */
export async function deleteList(listId: number): Promise<List> {
	if (!Number.isFinite(listId) || listId <= 0) {
		throw new HttpError(`Invalid listId: ${listId}`);
	}
	try {
		const { data, error } = await listsRoute({ listId }).delete();
		if (error) throw toHttpError(error, 'Unable to delete list');
		return unwrapData<List>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to delete list');
	}
}

/**
 * Get a public list by username and slug.
 */
export async function getListData(username: string, slug: string): Promise<ListPageData> {
	const validUser = typeof username === 'string' && /^[a-zA-Z0-9_-]{3,32}$/.test(username);
	const validSlug = typeof slug === 'string' && slug.trim().length > 0;
	if (!validUser) throw new HttpError(`Invalid username: ${username}`);
	if (!validSlug) throw new HttpError(`Invalid slug: ${slug}`);

	try {
		const { data, error } = await client.api.v1.user({ username }).lists({ slug }).get();
		if (error) throw toHttpError(error, 'Unable to load list');
		return unwrapData<ListPageData>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to load list');
	}
}

/**
 * Add an item to a list.
 */
export async function addListItem(data: InsertListItem): Promise<AddListItemResult> {
	const { listId, mediaType, mediaId } = data || ({} as InsertListItem);
	if (!Number.isFinite(listId) || listId <= 0) {
		throw new HttpError(`Invalid listId: ${listId}`);
	}
	if (mediaType !== 'movie' && mediaType !== 'tv') {
		throw new HttpError(`Invalid mediaType: ${mediaType}`);
	}
	if (!Number.isFinite(mediaId) || mediaId <= 0) {
		throw new HttpError(`Invalid mediaId: ${mediaId}`);
	}

	try {
		const { data: listItems, error } = await listItemsRoute.post({
			listId,
			mediaType,
			mediaId
		});
		if (error) throw toHttpError(error, 'Unable to add list item');
		return unwrapData<AddListItemResult>(listItems);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to add list item');
	}
}

/**
 * Get current user's list item for a media id.
 */
export async function getListItem(
	mediaType: 'movie' | 'tv',
	mediaId: number
): Promise<SavedListItem> {
	if (mediaType !== 'movie' && mediaType !== 'tv') {
		throw new HttpError(`Invalid mediaType: ${mediaType}`);
	}
	if (!Number.isFinite(mediaId) || mediaId <= 0) {
		throw new HttpError(`Invalid mediaId: ${mediaId}`);
	}

	try {
		const { data, error } = await listItemsRoute.get({
			query: { mediaType, mediaId }
		});
		if (error) throw toHttpError(error, 'Unable to load list item');
		return unwrapData<SavedListItem>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to load list item');
	}
}

/**
 * Delete a list item by id.
 */
export async function deleteListItem(id: number): Promise<null> {
	if (!Number.isFinite(id) || id <= 0) {
		throw new HttpError(`Invalid id: ${id}`);
	}
	try {
		const { data, error } = await listItemsRoute({ id }).delete();
		if (error) throw toHttpError(error, 'Unable to delete list item');
		return unwrapData<null>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to delete list item');
	}
}

/**
 * Fetch popular lists ordered by total view count.
 */
export async function getPopularLists(limit = 10): Promise<PopularList[]> {
	try {
		const { data, error } = await listsRoute.popular.get({ query: { limit } });
		if (error) throw toHttpError(error, 'Unable to load popular lists');
		return unwrapData<PopularList[]>(data);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to load popular lists');
	}
}

/**
 * Fetch lists for a specific username.
 */
export async function getUserLists(username: string): Promise<PopularList[]> {
	if (typeof username !== 'string' || username.trim().length === 0) {
		throw new HttpError('Username is required');
	}

	try {
		const { data, error } = await client.api.v1.user({ username }).lists.get();
		if (error) throw toHttpError(error, 'Unable to load user lists');
		const lists = unwrapData<List[]>(data);
		return lists.map((l) => ({ ...l, username, viewCount: 0 }));
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw toHttpError(err, 'Failed to load user lists');
	}
}
