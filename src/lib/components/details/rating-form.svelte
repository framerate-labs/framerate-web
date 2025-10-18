<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { addReview } from '$services/reviews';
	import { toast } from 'svelte-sonner';

	import { ratingSchema } from '$lib/schemas/review';
	import { userStore } from '$lib/stores/user-store.svelte';
	import { validateRating, mapFiveToTen } from '$lib/utils/rating';

	import StarRating from './star-rating.svelte';

	type Props = {
		media: MediaDetails;
	};

	let { media }: Props = $props();

	let rating = $state<number | null>(null);

	const queryClient = useQueryClient();

	const reviewMutation = createMutation(() => ({
		mutationFn: async (values: { rating: string }) => {
			const { mediaType, id: mediaId } = media;
			await addReview(mediaType, mediaId, values.rating, queryClient);
		},
		onSuccess: () => {
			const { mediaType, id: mediaId } = media;

			toast.success('Review updated');

			queryClient.invalidateQueries({
				queryKey: ['average-rating', mediaType, mediaId]
			});

			queryClient.invalidateQueries({
				queryKey: ['review', mediaType, mediaId]
			});

			queryClient.invalidateQueries({
				queryKey: ['library']
			});
		},
		onError: (error: Error) => {
			toast.error(error.message || 'Failed to save review. Please try again later.');
		}
	}));

	async function handleRating(ratingValue: number) {
		if (!userStore.isLoggedIn) {
			toast.info('Please log in to save reviews');
			return;
		}

		onSubmit({ rating: String(ratingValue) });
	}

	function onSubmit(values: { rating: string }) {
		const parsed = ratingSchema.safeParse(values);

		if (!parsed.success) {
			toast.error('Please provide a valid rating');
			return;
		}

		const error = validateRating(parsed.data.rating);

		if (error) {
			toast.error(error);
			return;
		}

		// Map UI rating (0.5-5 scale) to DB rating (1-10 scale)
		const uiRating = parseFloat(parsed.data.rating);
		const dbRating = mapFiveToTen(uiRating);

		reviewMutation.mutate({ rating: String(dbRating) });
	}
</script>

<form>
	<StarRating {media} bind:rating {handleRating} />
</form>
