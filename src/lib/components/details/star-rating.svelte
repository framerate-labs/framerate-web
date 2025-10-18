<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';

	import StarIcon from '$components/icons/star-icon.svelte';
	import { deleteReview, getReview } from '$services/reviews';
	import { userStore } from '$stores/user-store.svelte';
	import { mapRatingToFiveScale } from '$utils/rating';

	type Props = {
		media: MediaDetails;
		rating: number | null;
		handleRating: (rating: number) => Promise<void>;
	};

	let { media, rating = $bindable(), handleRating }: Props = $props();

	let hover = $state<number | null>(null);

	const queryClient = useQueryClient();

	const reviewQuery = createQuery(() => ({
		queryKey: ['review', media.mediaType, media.id],
		queryFn: () => getReview(media.mediaType, media.id),
		staleTime: 2 * 60 * 1000,
		gcTime: 5 * 60 * 1000,
		enabled: userStore.isLoggedIn
	}));

	const groupedStars = [
		[0.5, 1],
		[1.5, 2],
		[2.5, 3],
		[3.5, 4],
		[4.5, 5]
	];

	$effect(() => {
		if (reviewQuery.data) {
			// DB stores ratings on 1-10 scale, map to 0.5-5 for display
			const dbRating = parseFloat(reviewQuery.data.rating);
			rating = mapRatingToFiveScale(dbRating);
		}

		return () => {
			rating = null;
		};
	});

	async function handleClick(ratingValue: number) {
		if (rating === ratingValue && userStore.isLoggedIn) {
			// Delete existing rating (clicking same star again)
			const { mediaType, id: mediaId } = media;
			rating = null;
			hover = null;

			try {
				await deleteReview(mediaType, mediaId, queryClient);
				// If we get here, deletion succeeded
				toast.info('Rating removed');

				queryClient.invalidateQueries({
					queryKey: ['average-rating', media.mediaType, media.id]
				});
				queryClient.invalidateQueries({
					queryKey: ['review', mediaType, mediaId]
				});
				queryClient.invalidateQueries({
					queryKey: ['library']
				});
			} catch {
				toast.error('Failed to delete rating. Please try again later');
			}
		} else {
			// Set new rating
			rating = ratingValue;
		}
	}
</script>

<div class="relative">
	<div class="flex items-center justify-center gap-1 md:gap-0">
		{#each groupedStars as group, index (index)}
			<span
				class="relative transition-transform duration-100 ease-out hover:scale-[1.15] active:scale-105"
			>
				{#each group as star (star)}
					{@const ratingValue = star}
					<label class={`${ratingValue % 1 !== 0 ? 'absolute w-[50%] overflow-hidden' : ''}`}>
						<input
							type="radio"
							name="rating"
							value={ratingValue}
							aria-label={`Rate ${ratingValue} stars`}
							onclick={async () => {
								const shouldSaveRating = rating !== ratingValue;
								handleClick(ratingValue);
								if (shouldSaveRating) await handleRating(ratingValue);
							}}
							class="hidden"
						/>
						<StarIcon
							fill={ratingValue <= (hover || rating || 0) ? '#FFD43B' : '#333'}
							classes="size-10 md:w-9 lg:h-8 lg:w-10"
							onMouseEnter={() => (hover = ratingValue)}
							onMouseLeave={() => (hover = null)}
						/>
					</label>
				{/each}
			</span>
		{/each}
	</div>
</div>
