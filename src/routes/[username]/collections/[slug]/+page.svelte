<script lang="ts">
	// import ArrowUp from '@lucide/svelte/icons/arrow-up';

	import type { RouteParams } from '../../../[username]/collections/[slug]/$types';

	import ArrowLeftCircle from '@lucide/svelte/icons/circle-arrow-left';
	import { createQuery } from '@tanstack/svelte-query';
	import { getListData } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import ListDescription from '$components/lists/list-description.svelte';
	import ListGrid from '$components/lists/list-grid.svelte';
	import SideCard from '$components/lists/side-card.svelte';

	const { username, slug } = page.params as RouteParams;

	const listDataQuery = createQuery(() => ({
		queryKey: ['list-items', username, slug],
		queryFn: () => getListData(username, slug),
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		retry: 2
	}));

	$effect(() => {
		if (listDataQuery.isFetched && listDataQuery.data === undefined) {
			toast.error('Failed to load collection data. Please try again later.');
		}
	});

	let listData = $derived(listDataQuery.data);
	let isFetching = $derived(listDataQuery.isFetching);
</script>

<main class="px-2 pb-20 md:px-0">
	<!-- <Backdrop
        collection
        backdropPath="/lvOLivVeX3DVVcwfVkxKf0R22D8.jpg"
        alt="Decorative image describing this collection."
      /> -->
	<!-- <div class="relative -top-28 mt-10"> -->
	<div class="relative mt-10">
		<a href={resolve('/collections')} aria-label="Back to collections">
			<ArrowLeftCircle
				size={26}
				strokeWidth={1.5}
				class="mb-6 cursor-pointer text-gray transition-colors duration-200 hover:text-white"
			/>
		</a>

		{#if listData}
			<ListDescription {listData} />

			<div class="flex size-full flex-col gap-2.5 md:flex-row">
				<ListGrid {listData} {isFetching} />
				<SideCard {listData} />
			</div>
		{/if}
	</div>

	<!-- <TooltipProvider>
		<Tooltip side="top" sideOffset={12} content="Scroll to top" key1="T">
			<button
				class={[
					// isArrowVisible ? 'animate-fade-in' : '',
					// isArrowVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
					'fixed right-4 bottom-4 rounded-full p-2 shadow-lg transition-colors duration-200 outline-none hover:bg-white/5'
				]}
				aria-label="Scroll to top"
			>
				<ArrowUp strokeWidth={1.5} />
			</button>
		</Tooltip>
	</TooltipProvider> -->
</main>
