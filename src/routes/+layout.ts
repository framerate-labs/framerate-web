import { QueryClient } from '@tanstack/svelte-query';
import type { LayoutLoad } from './$types';
import { browser } from '$app/environment';

export const load: LayoutLoad = () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				enabled: browser,
				staleTime: 1000 * 60 * 5, // 5 minutes
				gcTime: 1000 * 60 * 10 // 10 minutes
			}
		}
	});

	return { queryClient };
};
