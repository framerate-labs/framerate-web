import type { PageLoad } from './$types';

import { browser } from '$app/environment';
import { getDetails } from '$services/details';
import { getAvgRating } from '$services/reviews';

export const load: PageLoad = async ({ params, parent }) => {
	const { queryClient } = await parent();

	if (browser) {
		await Promise.all([
			queryClient.prefetchQuery({
				queryKey: ['movie-details', params.id],
				queryFn: () => getDetails('movie', params.id),
				staleTime: 5 * 60 * 1000,
				gcTime: 10 * 60 * 1000
			}),
			queryClient.prefetchQuery({
				queryKey: ['average-rating', 'movie', Number(params.id)],
				queryFn: () => getAvgRating('movie', Number(params.id)),
				staleTime: 3 * 60 * 1000,
				gcTime: 6 * 60 * 1000
			})
		]);
	}

	return {
		movieId: params.id
	};
};
