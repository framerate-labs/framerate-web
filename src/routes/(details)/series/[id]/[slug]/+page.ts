import type { PageLoad } from './$types';

import { getDetails } from '$services/details';
import { getAvgRating } from '$services/reviews';

export const load: PageLoad = async ({ params, parent }) => {
	const { queryClient } = await parent();

	await Promise.all([
		queryClient.prefetchQuery({
			queryKey: ['tv-details', params.id],
			queryFn: () => getDetails('tv', params.id),
			staleTime: 5 * 60 * 1000,
			gcTime: 10 * 60 * 1000
		}),
		queryClient.prefetchQuery({
			queryKey: ['average-rating', 'tv', Number(params.id)],
			queryFn: () => getAvgRating('tv', Number(params.id)),
			staleTime: 3 * 60 * 1000,
			gcTime: 6 * 60 * 1000
		})
	]);

	return {
		seriesId: params.id
	};
};
