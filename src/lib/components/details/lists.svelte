<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { createQuery } from '@tanstack/svelte-query';
	import { addListItem, deleteListItem, getLists } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import BoxIcon from '$components/icons/box-icon.svelte';
	import CheckboxIcon from '$components/icons/checkbox-icon.svelte';
	import { authClient } from '$lib/auth-client';

	type SavedToList = {
		listId: number;
		listItemId: number;
		mediaType: string;
		mediaId: number | null;
	};

	type Props = {
		media: MediaDetails;
		savedToLists: SavedToList[];
	};

	let { media, savedToLists }: Props = $props();

	let checkboxRef: HTMLInputElement;

	const authSession = authClient.useSession();
	const user = $authSession.data?.user;

	const { mediaType, id: mediaId } = media;

	const listQuery = createQuery(() => ({
		queryKey: ['lists'],
		queryFn: getLists,
		staleTime: 3 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		enabled: user !== undefined
	}));

	if (user && listQuery.isFetched && !listQuery.data) {
		toast.error('Something went wrong while getting lists!');
	}

	async function handleClick(listId: number) {
		const matchedLists = savedToLists.filter((savedList) => savedList.listId === listId);

		// Item not saved in clicked list -- add it
		if (matchedLists.length === 0) {
			const requestData = { listId, mediaType, mediaId };

			try {
				await addListItem(requestData);
			} catch {
				return toast.error('Failed to add to list! Please try again later.');
			}

			toast.success('Added to list');
		}

		// Item is already saved in the clicked list -- delete it.
		if (matchedLists.length > 0) {
			matchedLists.forEach(async (list) => {
				const { listItemId } = list;
				try {
					await deleteListItem(listItemId);
				} catch {
					return toast.error('Failed to remove from list! Please try again later.');
				}
			});

			toast.success('Removed from list');
		}

		// invalidate queries that had data mutated
		// Think about list vs list-item query before invalidating
	}

	const idList = savedToLists.map((savedItem) => savedItem.listId);
</script>

{#if listQuery.isSuccess}
	{#each listQuery.data as list (list.id)}
		<label class="mb-2.5 flex w-fit cursor-pointer items-center select-none">
			<input
				bind:this={checkboxRef}
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
