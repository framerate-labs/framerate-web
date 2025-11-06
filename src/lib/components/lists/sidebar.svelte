<script lang="ts">
	import type { PageData } from '../../../routes/collections/$types';

	import Plus from '@lucide/svelte/icons/plus';
	import { createQuery } from '@tanstack/svelte-query';
	import { getLists } from '$services/lists';

	import { resolve } from '$app/paths';

	import * as AlertDialog from '$components/ui/alert-dialog/index';
	import { userStore } from '$stores/user-store.svelte';

	import CreateListForm from './create-list-form.svelte';
	import ListDialog from './list-dialog.svelte';

	let { formData }: { formData: PageData } = $props();

	const username = userStore.username ?? '';

	let dialogOpen = $state(false);

	const listsQuery = createQuery(() => ({
		queryKey: ['lists'],
		queryFn: getLists,
		staleTime: 10 * 60 * 1000,
		gcTime: 20 * 60 * 1000
	}));

	const lists = $derived(listsQuery.data);
</script>

<nav
	class="sticky top-10 flex w-full grow animate-fade-in flex-col gap-4 overflow-x-hidden overflow-y-auto rounded-lg bg-background-dark px-3 py-5"
>
	<div class="flex items-center justify-between pr-1 pl-2">
		<h2 class="text-left text-lg font-semibold">Your Collections</h2>
		<ListDialog
			bind:open={dialogOpen}
			title="Create Collection"
			description="Fill and submit the form to create a collection"
			{dialogTrigger}
			{dialogContent}
			{footerContent}
		></ListDialog>
	</div>

	<div class="animate-fade-in">
		{#if lists && lists.length > 0}
			{#each lists as list (list.id)}
				<a
					href={resolve('/[username]/collections/[slug]', { username, slug: list.slug })}
					class="group my-1 flex h-12 items-center justify-between gap-3.5 rounded-md py-1.5 pl-2 transition-colors duration-75 ease-in hover:bg-white/8"
				>
					<p class="text-foreground/70 transition-all group-hover:text-foreground">
						{list.name}
					</p>
					<div
						class="h-8 w-1 rounded-tl rounded-bl bg-indigo-500 opacity-0 transition-opacity group-hover:opacity-100"
					></div>
				</a>
			{/each}
		{/if}
	</div>
</nav>

{#snippet dialogTrigger()}
	<button class="rounded-full p-1 transition-colors duration-150 ease-in hover:bg-white/5">
		<Plus
			strokeWidth={1.5}
			class="relative rounded-full text-gray transition-colors duration-150 ease-in hover:text-foreground"
		/>
	</button>
{/snippet}

{#snippet dialogContent()}
	<CreateListForm data={formData} onSuccess={() => (dialogOpen = false)} />
{/snippet}

{#snippet footerContent()}
	<AlertDialog.Footer class="mt-8">
		<AlertDialog.Cancel
			class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-light"
			>Cancel</AlertDialog.Cancel
		>
		<AlertDialog.Action
			type="submit"
			form="create-list-form"
			class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-indigo-700"
			>Create</AlertDialog.Action
		>
	</AlertDialog.Footer>
{/snippet}
