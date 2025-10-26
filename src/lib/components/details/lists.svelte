<script lang="ts">
	import type { MediaDetails } from '$types/details';
	import type { SavedToList } from '$types/lists';

	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { addListItem, deleteListItem, getLists } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import BoxIcon from '$components/icons/box-icon.svelte';
	import CheckboxIcon from '$components/icons/checkbox-icon.svelte';
	import { authClient } from '$lib/auth-client';

	type Props = {
		media: MediaDetails;
		savedToLists: SavedToList[];
		onListItemAdded?: (item: SavedToList) => void;
		onListItemRemoved?: (listItemId: number) => void;
	};

	let { media, savedToLists, onListItemAdded, onListItemRemoved }: Props = $props();

	const queryClient = useQueryClient();
	const authSession = authClient.useSession();
	const user = $derived($authSession.data?.user);

	const { mediaType, id: mediaId } = media;

	const listQuery = createQuery(() => ({
		queryKey: ['lists'],
		queryFn: getLists,
		staleTime: 3 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		enabled: user !== undefined
	}));

	$effect(() => {
		if (user && listQuery.isFetched && !listQuery.data) {
			toast.error('Something went wrong while getting lists!');
		}
	});

	const addListItemMutation = createMutation(() => ({
		mutationFn: async (requestData: {
			listId: number;
			mediaType: 'movie' | 'tv';
			mediaId: number;
		}) => {
			return await addListItem(requestData);
		},
		onSuccess: (data) => {
			const item = data.item;
			const newListItem: SavedToList = {
				listId: item.listId,
				listItemId: item.id,
				mediaType: item.mediaType,
				mediaId: item.movieId ?? item.seriesId
			};
			onListItemAdded?.(newListItem);
			queryClient.invalidateQueries({ queryKey: ['listItems', mediaType, mediaId] });
			toast.success('Added to list');
		},
		onError: () => {
			toast.error('Failed to add to list! Please try again later.');
		}
	}));

	const deleteListItemMutation = createMutation(() => ({
		mutationFn: async (listItemId: number) => {
			return await deleteListItem(listItemId);
		},
		onSuccess: (_, listItemId) => {
			onListItemRemoved?.(listItemId);
			queryClient.invalidateQueries({ queryKey: ['listItems', mediaType, mediaId] });
			toast.success('Removed from list');
		},
		onError: () => {
			toast.error('Failed to remove from list! Please try again later.');
		}
	}));

	function handleClick(listId: number) {
		const matchedLists = savedToLists.filter((savedList) => savedList.listId === listId);

		// Item not saved in selected list -- add it
		if (matchedLists.length === 0) {
			addListItemMutation.mutate({ listId, mediaType, mediaId });
		}

		// Item is already saved in the selected list -- delete it.
		if (matchedLists.length > 0) {
			matchedLists.forEach((list) => {
				deleteListItemMutation.mutate(list.listItemId);
			});
		}
	}

	const idList = savedToLists.map((savedItem) => savedItem.listId);
</script>

{#if listQuery.isSuccess}
	{#each listQuery.data as list (list.id)}
		<label class="mb-2.5 flex w-fit cursor-pointer items-center select-none">
			<input
				type="checkbox"
				name="listId"
				value={list.id}
				defaultChecked={idList.includes(list.id)}
				onclick={() => handleClick(list.id)}
				class="peer hidden"
			/>
			<CheckboxIcon
				fillPrimary="#00e4f5"
				fillSecondary="#262626"
				classes="hidden peer-checked:block"
			/>
			<BoxIcon fill="#262626" classes="peer-checked:hidden" />
			<span class="ml-1.5">{list.name}</span>
		</label>
	{/each}
{/if}
