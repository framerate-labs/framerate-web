import type { PageLoad } from './$types';

import { getTrending } from '$services/trending';

export const load: PageLoad = async ({ parent }) => {
	const { queryClient } = await parent();

	await Promise.all([
		queryClient.prefetchQuery({
			queryKey: ['trending', 'movie', 'week'],
			queryFn: () => getTrending({ filter: 'movie', timeWindow: 'week' })
		}),
		queryClient.prefetchQuery({
			queryKey: ['trending', 'tv', 'week'],
			queryFn: () => getTrending({ filter: 'tv', timeWindow: 'week' })
		})
	]);
};
