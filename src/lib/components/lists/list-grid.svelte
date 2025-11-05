<script lang="ts">
	import type { ListData, ListItem } from '$types/lists';

	import PosterGrid from '$components/shared/poster-grid.svelte';

	import ListGridSkeleton from './list-grid-skeleton.svelte';

	interface Props {
		listData: ListData;
		isFetching: boolean;
	}

	let { listData, isFetching }: Props = $props();
	let displayData: ListItem[] | undefined = $state();

	// Keep UI in sync with server data after mutations; update when fetch completes
	$effect(() => {
		if (!isFetching && listData) {
			displayData = listData.listItems;
		}
	});

	const showContainerBg = $derived(isFetching || (displayData && displayData.length > 0));
</script>

<section
	class={[
		showContainerBg ? 'overflow-auto border border-white/10 bg-background-dark' : '',
		'order-2 rounded-md p-3 md:order-1 md:w-4/5 md:p-4 lg:p-6'
	]}
>
	{#if isFetching}
		<ListGridSkeleton />
	{/if}

	{#if !isFetching && (!displayData || displayData.length === 0)}
		<div class="flex size-full items-center justify-center">
			<p class="font-medium">Add your first film or series to this collection!</p>
		</div>
	{/if}

	{#if displayData && displayData.length > 0}
		<PosterGrid
			mediaArray={displayData}
			isTooltipEnabled={false}
			classes="grid-cols-3 gap-2 md:grid-cols-4 lg:grid-cols-5 lg:gap-3.5"
		/>
	{/if}
</section>
