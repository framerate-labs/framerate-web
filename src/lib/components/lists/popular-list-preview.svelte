<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { getListData } from '$services/lists';

	interface Props {
		username: string;
		slug: string;
	}

	let { username, slug }: Props = $props();

	const listDataQuery = createQuery(() => ({
		queryKey: ['list-preview', username, slug],
		queryFn: () => getListData(username, slug),
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000
	}));

	let listItems = $derived(listDataQuery.data?.listItems);

	const posters = $derived.by(
		() =>
			listItems
				?.map((i) => i.posterPath)
				.filter(Boolean)
				.slice(0, 4) ?? []
	);
</script>

{#if listDataQuery.isFetching && posters.length === 0}
	<div class="size-full shrink-0 animate-pulse bg-background-light"></div>
{:else if posters.length === 0}
	<div
		class="flex size-full shrink-0 items-center justify-center bg-background-light text-xs text-neutral-300"
	>
		No preview
	</div>
{/if}

<div class="grid size-full shrink-0 grid-cols-2 grid-rows-2 gap-0.5 bg-background">
	{#each posters as posterSrc (posterSrc)}
		<img
			src={`https://image.tmdb.org/t/p/w185${posterSrc}`}
			alt="Grid featuring media poster images from the list."
			class="size-full object-cover"
			loading="lazy"
		/>
	{/each}
</div>
