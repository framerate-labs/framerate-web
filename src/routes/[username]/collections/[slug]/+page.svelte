<script lang="ts">
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

	const listDataQuery = createQuery(() => {
		const { username, slug } = page.params as RouteParams;
		return {
			queryKey: ['list-items', username, slug],
			queryFn: () => getListData(username, slug),
			staleTime: 5 * 60 * 1000,
			gcTime: 10 * 60 * 1000,
			retry: 2
		};
	});

	$effect(() => {
		if (listDataQuery.isFetched && listDataQuery.data === undefined) {
			toast.error('Failed to load collection data. Please try again later.');
		}
	});

	let listData = $derived(listDataQuery.data);
	let isFetching = $derived(listDataQuery.isFetching);

	const pageTitle = $derived.by(() => {
		const { username } = page.params as RouteParams;
		return listData
			? `${listData.list.name} by ${username} - FrameRate`
			: 'User Collection - FrameRate';
	});
	const pageDescription = 'Explore user-created collections of movies and TV series on FrameRate.';
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
</svelte:head>

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
</main>
