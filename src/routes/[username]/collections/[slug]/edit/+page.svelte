<script lang="ts">
	import type { PageData, RouteParams } from './$types';

	import CircleArrowLeft from '@lucide/svelte/icons/circle-arrow-left';
	import { createQuery } from '@tanstack/svelte-query';
	import { getListData } from '$services/lists';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import EditListForm from '$components/lists/edit-list-form.svelte';
	// import EditListItems from '$components/lists/edit-list-items.svelte';
	import { sortTitles } from '$lib/utils/strings';

	let { data }: { data: PageData } = $props();

	let username = $derived((page.params as RouteParams).username);
	let slug = $derived((page.params as RouteParams).slug);

	let returnSlug = $state(slug);

	const listItemsQuery = createQuery(() => {
		const { username, slug } = page.params as RouteParams;
		return {
			queryKey: ['list-items', username, slug],
			queryFn: () => getListData(username, slug),
			staleTime: 2 * 60 * 1000,
			gcTime: 5 * 60 * 1000
		};
	});

	let listData = $derived(listItemsQuery.data);

	const sortedListItems = sortTitles(listItemsQuery.data?.listItems);

	function handleClick() {
		const path = resolve('/[username]/collections/[slug]', {
			username,
			slug: returnSlug
		});
		goto(path);
	}

	$effect(() => {
		if (listItemsQuery.isFetched && listItemsQuery.error) {
			// If the collection cannot be loaded, navigate back to the details page
			goto(resolve('/[username]/collections/[slug]', { username, slug }), { replaceState: true });
		}
	});
</script>

<div>
	<header class="mt-9 mb-6 border-b border-white/8">
		<div class="mx-auto w-full">
			<h1 class="mb-4 text-[22px] font-semibold">Edit Collection</h1>
		</div>
	</header>

	<main>
		<div class="mx-auto px-1">
			<button onclick={handleClick}>
				<CircleArrowLeft
					size={26}
					strokeWidth={1.5}
					class="mb-6 cursor-pointer text-gray transition-colors duration-200 hover:text-white"
				/>
			</button>
			{#if listData}
				<div class="grid grid-cols-1 gap-5 md:grid-cols-2">
					<div>
						<EditListForm bind:returnSlug {data} {username} {slug} {listData} />
					</div>

					<section
						class="flex h-[220px] items-center justify-center rounded-md bg-background-light md:h-[320px]"
					>
						<p class="text-base font-medium">Image upload coming soon!</p>
					</section>
				</div>

				<hr class="my-3 bg-background" />

				<section class="mb-20">
					<div class="mb-6">
						<h2 class="font-medium">Edit Items</h2>
						<span class="text-sm tracking-wide text-gray"> Select poster to remove from list </span>
					</div>

					<!-- <EditListItems listItems={sortedListItems} {username} {slug} /> -->
				</section>
			{/if}
		</div>
	</main>
</div>
