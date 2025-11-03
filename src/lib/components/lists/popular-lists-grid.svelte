<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { getUserLists } from '$services/lists';

	import PopularListCardSkeleton from '$components/lists/popular-list-card-skeleton.svelte';
	import PopularListCard from '$components/lists/popular-list-card.svelte';

	const listQuery = createQuery(() => ({
		queryKey: ['user-lists', 'framerate'],
		queryFn: () => getUserLists('framerate'),
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000
	}));

	let data = $derived(listQuery.data);
</script>

{#if listQuery.error}
	<div class="mx-auto py-10 text-center text-sm text-white/70">Failed to load collections.</div>
{/if}

<div class="animate-fade-in">
	<h2 class="mt-1 mb-4 text-lg font-medium md:text-xl">Popular Collections</h2>
	<div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
		{#if listQuery.isLoading && !data}
			{#each Array.from({ length: 10 }), index (index)}
				<PopularListCardSkeleton />
			{/each}
		{/if}

		{#if data}
			{#each data as list (list.id)}
				<PopularListCard {list} />
			{/each}
		{/if}
	</div>
</div>
