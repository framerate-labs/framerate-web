<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { updateReview } from '$services/actions';
	import { getReview } from '$services/reviews';
	import { debounce } from '$utils/debounce';
	import { toast } from 'svelte-sonner';

	import MediaActionIcon from '$components/icons/media-actions-icons.svelte';
	import { userStore } from '$stores/user-store.svelte';

	type Props = {
		media: MediaDetails;
	};

	let { media }: Props = $props();

	const { id: mediaId, mediaType } = media;

	// Local state for optimistic updates
	let isLiked = $state(false);
	let isWatched = $state(false);

	const reviewQuery = createQuery(() => ({
		queryKey: ['review', mediaType, mediaId],
		queryFn: () => getReview(mediaType, mediaId),
		staleTime: 2 * 60 * 1000,
		gcTime: 5 * 60 * 1000,
		enabled: userStore.isLoggedIn,
		retry: false
	}));

	const updateMutation = createMutation(() => ({
		mutationFn: async ({ field, value }: { field: 'liked' | 'watched'; value: boolean }) => {
			return await updateReview({ mediaType, mediaId, field, value });
		},
		onError: (error, variables) => {
			const { field, value } = variables;
			toast.error(`Failed to update ${field === 'liked' ? 'like' : 'watch'} status`);
			// Revert optimistic update on error
			if (field === 'liked') isLiked = !value;
			if (field === 'watched') isWatched = !value;
			console.error(error);
		}
	}));

	$effect(() => {
		if (reviewQuery.data) {
			isLiked = reviewQuery.data.liked;
			isWatched = reviewQuery.data.watched;
		}

		return () => {
			isLiked = false;
			isWatched = false;
		};
	});

	// Debounced mutation functions
	const debouncedMutateLike = debounce(
		(value: boolean) => updateMutation.mutate({ field: 'liked', value }),
		1000
	);

	const debouncedMutateWatch = debounce(
		(value: boolean) => updateMutation.mutate({ field: 'watched', value }),
		1000
	);

	function handleClick(actionName: 'like' | 'watch') {
		if (!userStore.isLoggedIn) {
			toast.info('Please log in to continue');
			return;
		}

		if (reviewQuery.data == null) {
			toast.info('Please submit a rating first');
			return;
		}

		if (actionName === 'like') {
			isLiked = !isLiked;
			debouncedMutateLike(isLiked);
		} else {
			isWatched = !isWatched;
			debouncedMutateWatch(isWatched);
		}
	}

	const actions = [
		{
			id: 1,
			name: 'like' as const,
			content: 'Like',
			component: 'heart' as const,
			active: 'fill-[#FF153A]',
			hover: 'hover:fill-[#FF153A]'
		},
		{
			id: 2,
			name: 'watch' as const,
			content: 'Mark watched',
			component: 'eye' as const,
			active: 'fill-[#00e4f5]',
			hover: 'hover:fill-[#00e4f5]'
		}
	];
</script>

<div class="mt-3 flex w-full items-center justify-evenly gap-0 px-1.5">
	{#each actions as action (action.id)}
		{@const isActive =
			(action.name === 'like' && isLiked) || (action.name === 'watch' && isWatched)}
		<div>
			<MediaActionIcon
				component={action.component}
				fill="#333"
				classes={[
					action.hover,
					isActive ? action.active : '',
					'cursor-pointer ease transition-all duration-150 active:scale-90 h-8'
				]}
				onclick={() => handleClick(action.name)}
			/>
		</div>
	{/each}

	<!-- Bookmark icon placeholder - to be implemented with lists modal -->
	<div>
		<MediaActionIcon
			component="bookmark"
			fill="#333"
			classes="cursor-pointer hover:fill-[#32EC44] h-8"
			onclick={() => toast.info('Lists feature coming soon!')}
		/>
	</div>
</div>
