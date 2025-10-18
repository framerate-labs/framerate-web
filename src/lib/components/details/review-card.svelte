<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { createQuery } from '@tanstack/svelte-query';
	import { getAvgRating } from '$services/reviews';

	import MediaActions from './media-actions.svelte';
	import RatingForm from './rating-form.svelte';

	type Props = {
		media: MediaDetails;
	};

	let { media }: Props = $props();

	const formatter = Intl.NumberFormat('en', { notation: 'compact' });

	const averageQuery = createQuery(() => ({
		queryKey: ['average-rating', media.mediaType, media.id],
		queryFn: () => getAvgRating(media.mediaType, media.id),
		staleTime: 3 * 60 * 1000,
		gcTime: 6 * 60 * 1000
	}));

	const isStoredReview = $derived(averageQuery.data && averageQuery.data.reviewCount > 0);
	const avgRating = $derived(
		averageQuery.data?.avgRating ? parseFloat(averageQuery.data.avgRating.toFixed(2)) : null
	);
	const reviewCount = $derived(averageQuery.data?.reviewCount ?? 0);
</script>

<div
	class="flex h-[206.5px] flex-col items-center justify-between gap-7 rounded bg-background-light p-3 shadow-md ring-1 ring-white/5 lg:px-5 lg:pt-4 lg:pb-5"
>
	<div class="flex w-full items-center justify-between">
		<h3 class={`${!isStoredReview ? 'm-auto' : ''} inline font-medium`}>
			{isStoredReview ? 'Ratings' : 'Leave the first review!'}
		</h3>

		<div>
			<div class="flex h-[40.5px] flex-col text-nowrap">
				{#if isStoredReview && avgRating}
					<p class="font-medium">
						<span class="font-semibold">{avgRating}</span> / 5
					</p>
					<span class="text-sm">
						{formatter.format(reviewCount)}
					</span>
				{/if}
			</div>
		</div>
	</div>

	<RatingForm {media} />
	<MediaActions {media} />
</div>
