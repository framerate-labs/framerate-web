import type { List } from '$types/lists';
import type { LayoutServerLoad } from './$types';

import { redirect } from '@sveltejs/kit';
import { createServerClient } from '$services/client-instance';
import { unwrapData } from '$utils/http-error';

export const load: LayoutServerLoad = async (event) => {
	const { params, request } = event;
	const { username, slug } = params;

	const serverClient = createServerClient(request);

	try {
		// Fetch the current user and the list data in parallel.
		const [userResponse, listDataResponse] = await Promise.all([
			serverClient.api.auth.me.get(),
			serverClient.api.v1.user({ username }).lists({ slug }).get()
		]);

		// Handle failed user fetch (e.g., no session cookie)
		if (userResponse.error) {
			// A 401 or 403 error from the 'me' endpoint is expected for logged-out users.
			// In this case, we redirect them as they are not the owner.
			throw redirect(303, `/${username}/collections/${slug}`);
		}

		// Handle failed list data fetch
		if (listDataResponse.error) {
			// This could be a 404 if the list doesn't exist, or a 500.
			// In any case, the user shouldn't be on the edit page.
			throw redirect(303, `/${username}/collections/${slug}`);
		}

		const currentUser = userResponse.data;
		const listContainer = unwrapData<{ data: { list: List } }>(listDataResponse);
		const listData = listContainer?.data?.list;

		// If either data is missing, or if the user IDs don't match, redirect.
		if (!currentUser || !listData || currentUser?.userId !== listData?.userId) {
			throw redirect(303, `/${username}/collections/${slug}`);
		}

		// If all checks pass, return the data to the page
		return {
			listData
		};
	} catch (error) {
		// If the error is already a redirect response, re-throw it.
		if (error instanceof Response && error.status >= 300 && error.status < 400) {
			throw error;
		}

		// For any other unexpected errors, log it and redirect.
		console.error('Error in edit page middleware:', error);
		throw redirect(303, `/${username}/collections/${slug}`);
	}
};
