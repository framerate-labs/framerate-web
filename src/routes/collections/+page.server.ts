import type { List } from '$lib/types/lists.js';
import type { Actions, PageServerLoad } from './$types.js';

import { fail } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import { createServerClient } from '$lib/services/client-instance.js';
import { HttpError, toHttpError, unwrapData } from '$lib/utils/http-error.js';
import { listSchema } from '$schema/list.js';

export const load: PageServerLoad = async () => {
	return {
		form: await superValidate(zod4(listSchema))
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event, zod4(listSchema));

		if (!form.valid) {
			return fail(400, {
				form
			});
		}

		const listName = form.data.listName.trim().slice(0, 100);

		try {
			const serverClient = createServerClient(event.request);
			const { data, error } = await serverClient.api.v1.lists.post({ listName });

			if (error) {
				throw toHttpError(error, 'Unable to create list');
			}

			unwrapData<List>(data);
			form.message = { type: 'success', text: 'Collection created successfully!' };
			return { form };
		} catch (error) {
			let errorMessage = 'Failed to create collection. Please try again later.';

			if (error instanceof HttpError && error.status === 401) {
				errorMessage = 'Please log in to create a collection';
			} else if (error instanceof Error) {
				// Check for duplicate slug/name constraint violation
				if (error.message.includes('unique constraint') && error.message.includes('slug')) {
					errorMessage =
						'A collection with this name already exists. Please choose a different name.';
				} else {
					errorMessage = error.message;
				}
			}

			form.message = {
				type: 'error',
				text: errorMessage
			};
			return fail(500, { form });
		}
	}
};
