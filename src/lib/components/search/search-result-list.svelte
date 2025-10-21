<script lang="ts">
	import type { MediaDetails } from '$types/details';
	import type { Trending } from '$types/trending';

	import { createQuery } from '@tanstack/svelte-query';
	import { getDetails } from '$services/details';
	import { searchMediaClient } from '$services/search-client';
	import { getTrending } from '$services/trending';
	import { debounce } from '$utils/debounce';
	import { toast } from 'svelte-sonner';

	import SearchResult from './search-result.svelte';

	let { query }: { query: string } = $props();

	let debouncedQuery = $state('');
	const updateDebouncedQuery = debounce((value: string) => {
		debouncedQuery = value;
	}, 300);

	$effect(() => {
		updateDebouncedQuery(query);
	});

	// Initial data when no search query
	const trendingQuery = createQuery(() => ({
		queryKey: ['all-trending-day'],
		queryFn: () => getTrending({ filter: 'all', timeWindow: 'day' }),
		staleTime: 10 * 60 * 1000,
		gcTime: 20 * 60 * 1000
	}));

	const searchQuery = createQuery(() => ({
		queryKey: ['search', debouncedQuery],
		queryFn: async ({ signal }) => {
			try {
				return await searchMediaClient(debouncedQuery, signal);
			} catch (_err) {
				return [];
			}
		},
		staleTime: 2 * 60 * 1000,
		gcTime: 3 * 60 * 1000,
		enabled: debouncedQuery.length > 0
	}));

	let sourceResults = $derived.by(() => {
		if (trendingQuery.error) {
			toast.error('An error occurred while fetching trending data!', {
				duration: 5000
			});
			return [];
		}

		if (searchQuery.error) {
			toast.error('Something went wrong while getting search results!');
			return [];
		}

		if (debouncedQuery.length === 0 && trendingQuery.data) {
			return trendingQuery.data.slice(0, 10);
		}

		if (searchQuery.data) {
			return searchQuery.data;
		}

		return [];
	});

	let detailsData = $state<MediaDetails[]>([]);

	$effect(() => {
		const results = sourceResults;

		if (results.length === 0) {
			detailsData = [];
			return;
		}

		const detailsPromises = results.map((media) =>
			getDetails(media.mediaType, media.id.toString()).catch((err) => {
				console.error(`Failed to fetch details for ${media.mediaType} ${media.id}:`, err);
				return null;
			})
		);

		Promise.all(detailsPromises).then((fetchedDetails) => {
			detailsData = fetchedDetails.filter((d): d is MediaDetails => d !== null);
		});
	});
</script>

<div
	class="scrollbar-hide h-2/3 w-full overflow-auto rounded border border-white/10 bg-background-dark/80 p-2 shadow-sm backdrop-blur-2xl md:h-[350px] md:rounded-lg"
>
	{#each detailsData as data (`${data.mediaType}-${data.id}`)}
		<SearchResult media={data} />
	{/each}
</div>
