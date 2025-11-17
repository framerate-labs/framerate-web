<script lang="ts">
	import type { ListItem } from '$types/lists';

	import { useQueryClient } from '@tanstack/svelte-query';
	import { deleteListItem } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import Poster from '$components/shared/poster.svelte';
	import * as Dialog from '$components/ui/dialog/index';

	interface Props {
		listItems: ListItem[] | undefined;
		username: string;
		slug: string;
	}

	let { listItems, username, slug }: Props = $props();

	let selectedItems: number[] = $state([]);
	const queryClient = useQueryClient();

	function handleSelectItem(id: number) {
		if (selectedItems.includes(id)) {
			selectedItems = selectedItems.filter((item) => item !== id);
		} else {
			selectedItems = [...selectedItems, id];
		}
	}

	async function handleDeleteItem() {
		for (const item of selectedItems) {
			try {
				await deleteListItem(item);
				toast.success('Removed from list');
			} catch {
				return toast.error('Failed to remove from list');
			}
		}
		// Clear selected items
		selectedItems = [];
		// Refresh only the edited list page
		await queryClient.invalidateQueries({ queryKey: ['list-items', username, slug] });
	}
</script>

<div class="relative">
	<div class="grid grid-cols-3 gap-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
		{#if listItems}
			{#each listItems as listItem (listItem.listItemId)}
				<button onclick={() => handleSelectItem(listItem.listItemId)}>
					<div
						class={`${selectedItems.includes(listItem.listItemId) ? 'before:bg-blue-500/50' : ''} pointer-events-none relative mb-2 aspect-[2/3] w-24 duration-200 ease-in before:absolute before:inset-0 before:z-10 before:rounded before:transition-colors sm:w-28 md:w-32 lg:w-36`}
					>
						{#if listItem.posterPath}
							<Poster
								src={listItem.posterPath}
								fetchSize="w342"
								title={listItem.title}
								width={128}
								height={192}
								loading="lazy"
								fetchPriority="auto"
								perspectiveEnabled={false}
								classes="absolute inset-0 h-full w-full rounded object-cover"
							/>
						{/if}
					</div>
					<p class="pointer-events-none text-[0.8125rem] font-medium tracking-wide">
						{listItem.title}
					</p>
				</button>
			{/each}
		{/if}
	</div>

	<Dialog.Root>
		<Dialog.Trigger>
			<button
				class={`${selectedItems.length === 0 && 'hidden'} ease fixed right-6 bottom-14 z-50 animate-fade-in cursor-pointer rounded-md border border-red-700 bg-background px-4 py-2 font-medium transition-colors duration-150 hover:border-red-600 hover:bg-background-light`}
			>
				Remove selected
			</button>
		</Dialog.Trigger>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>Remove selected items?</Dialog.Title>
				<Dialog.Description
					>This action cannot be undone. Selected items will be removed from this list.</Dialog.Description
				>
			</Dialog.Header>
			<Dialog.Footer>
				<Dialog.Close>
					<button
						class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-background-light bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-light hover:text-foreground"
					>
						Cancel
					</button>
				</Dialog.Close>
				<Dialog.Close>
					<button
						onclick={handleDeleteItem}
						class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border-red-800 bg-red-700 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-red-800"
					>
						Remove
					</button>
				</Dialog.Close>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</div>
