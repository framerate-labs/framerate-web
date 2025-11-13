import type { LayoutLoad } from './$types';

import { QueryClient } from '@tanstack/svelte-query';

import { browser } from '$app/environment';

import { HttpError } from '$lib/utils/http-error';

let queryClient: QueryClient;

export const load: LayoutLoad = async () => {
	if (!queryClient) {
		queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					enabled: browser,
					staleTime: 1000 * 60 * 5,
					gcTime: 1000 * 60 * 10,
					retry: (failureCount, error) => {
						if (error instanceof HttpError && error.status === 401) {
							return false;
						}
						if (error instanceof HttpError && error.status === 429) {
							return false;
						}
						return failureCount < 2;
					}
				}
			}
		});
	}

	return {
		queryClient
	};
};
