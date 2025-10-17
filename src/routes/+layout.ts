import type { LayoutLoad } from './$types';

import { QueryClient } from '@tanstack/svelte-query';

import { browser } from '$app/environment';

let queryClient: QueryClient;

export const load: LayoutLoad = async ({ data }) => {
	if (!queryClient) {
		queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					enabled: browser,
					staleTime: 1000 * 60 * 5, // 5 minutes
					gcTime: 1000 * 60 * 10 // 10 minutes
				}
			}
		});
	}

	return {
		...data,
		queryClient
	};
};
