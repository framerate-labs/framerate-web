<script lang="ts">
	import type { MediaDetails } from '$types/details';
	import type { SavedToList } from '$types/lists';

	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { updateReview } from '$services/actions';
	import { getListItem } from '$services/lists';
	import { getReview } from '$services/reviews';
	import { debounce } from '$utils/debounce';
	import { toast } from 'svelte-sonner';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	import MediaActionIcon from '$components/icons/media-actions-icons.svelte';
	import MediaActionsIcons from '$components/icons/media-actions-icons.svelte';
	import Tooltip from '$components/shared/tooltip.svelte';
	import * as Dialog from '$components/ui/dialog/index';
	import { TooltipProvider } from '$components/ui/tooltip';
	import { authClient } from '$lib/auth-client';

	import Lists from './lists.svelte';

	type Props = {
		media: MediaDetails;
	};

	let { media }: Props = $props();

	const authSession = authClient.useSession();
	const user = $derived($authSession.data?.user);
	const { id: mediaId, mediaType } = media;

	// Local state for optimistic updates
	let isLiked = $state(false);
	let isWatched = $state(false);
	let savedToLists: SavedToList[] = $state([]);

	const reviewQuery = createQuery(() => ({
		queryKey: ['review', mediaType, mediaId],
		queryFn: () => getReview(mediaType, mediaId),
		staleTime: 2 * 60 * 1000,
		gcTime: 5 * 60 * 1000,
		enabled: user !== undefined
	}));

	const listItemsQuery = createQuery(() => ({
		queryKey: ['listItems', mediaType, mediaId],
		queryFn: () => getListItem(mediaType, mediaId),
		staleTime: 3 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		enabled: user !== undefined
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

	$effect(() => {
		if (listItemsQuery.data) {
			savedToLists = [listItemsQuery.data];
		}

		return () => (savedToLists = []);
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
		if (!user) {
			toast.info('Please log in to continue');
			goto(resolve('/login'));
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

	function handleListItemAdded(newListItem: SavedToList) {
		savedToLists = [...savedToLists, newListItem];
	}

	function handleListItemRemoved(listItemId: number) {
		savedToLists = savedToLists.filter((item) => item.listItemId !== listItemId);
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
	<TooltipProvider>
		{#each actions as action (action.id)}
			{@const isActive =
				(action.name === 'like' && isLiked) || (action.name === 'watch' && isWatched)}
			<Tooltip side="top" sideOffset={12} content={action.content}>
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
			</Tooltip>
		{/each}

		<Dialog.Root>
			<Tooltip side="top" sideOffset={12} content="Save">
				<Dialog.Trigger>
					{#snippet child({ props })}
						<MediaActionsIcons
							{...props}
							component="bookmark"
							fill="#333"
							classes={[
								savedToLists.length > 0 ? 'fill-[#32EC44]' : '',
								'cursor-pointer hover:fill-[#32EC44] h-8'
							]}
						/>
					{/snippet}
				</Dialog.Trigger>
			</Tooltip>

			<Dialog.Content
				class="top-[30%] w-4/5 border border-white/5 bg-background p-6 caret-foreground outline-none md:top-[50%] md:w-1/2 md:max-w-lg"
			>
				<Dialog.Header class="mb-4">
					<Dialog.Title class="mb-0.5 tracking-wide">Update Collections</Dialog.Title>
					<Dialog.Description>Save or remove content from your collections</Dialog.Description>
				</Dialog.Header>

				<div class="h-[300px] animate-fade-in overflow-y-scroll">
					<!-- <CreateList /> -->
					<Lists
						{media}
						{savedToLists}
						onListItemAdded={handleListItemAdded}
						onListItemRemoved={handleListItemRemoved}
					/>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	</TooltipProvider>
</div>
