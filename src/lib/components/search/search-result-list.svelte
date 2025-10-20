<script lang="ts">
	import type { MediaDetails } from '$types/details';
	import type { Trending } from '$types/trending';

	import { createQueries, createQuery } from '@tanstack/svelte-query';
	import { getDetails } from '$services/details';
	import { searchMedia } from '$services/search';
	import { getTrending } from '$services/trending';
	import { debounce } from '$utils/debounce';
	import { toast } from 'svelte-sonner';

	import SearchResult from './search-result.svelte';

	let { query }: { query: string } = $props();

	// Debounced search query
	let debouncedQuery = $state('');
	const updateDebouncedQuery = debounce((value: string) => {
		debouncedQuery = value;
	}, 300);

	$effect(() => {
		updateDebouncedQuery(query);
	});

	// Results state
	let results = $state<Trending[]>([]);

	// Query for trending data (shown when no search query)
	const trendingQuery = createQuery(() => ({
		queryKey: ['all-trending-day'],
		queryFn: () => getTrending({ filter: 'all', timeWindow: 'day' }),
		staleTime: 10 * 60 * 1000,
		gcTime: 15 * 60 * 1000
	}));

	// Query for search results
	const searchQuery = createQuery(() => ({
		queryKey: ['search', debouncedQuery],
		queryFn: async ({ signal }) => {
			try {
				return await searchMedia(debouncedQuery, signal);
			} catch (_err) {
				// For now, return empty array since search isn't implemented
				return [];
			}
		},
		staleTime: 2 * 60 * 1000,
		gcTime: 3 * 60 * 1000,
		enabled: debouncedQuery.length > 0
	}));

	// Queries for details of each result
	const detailsQueries = createQueries(() => ({
		queries: results.map((media) => ({
			queryKey: [`${media.mediaType}-details`, media.id],
			queryFn: () => getDetails(media.mediaType, media.id.toString()),
			staleTime: 2 * 60 * 1000,
			gcTime: 5 * 60 * 1000,
			enabled: results.length > 0
		}))
	}));

	// Update results based on trending or search data
	$effect(() => {
		const trending = trendingQuery.data;
		const search = searchQuery.data;
		const isSearching = searchQuery.isFetching;

		if (trendingQuery.error) {
			toast.error('An error occurred while fetching trending data!', {
				duration: 5000
			});
			return;
		}

		if (searchQuery.error) {
			toast.error('Something went wrong while getting search results!');
			return;
		}

		if (trending && !isSearching && !debouncedQuery) {
			results = trending.slice(0, 10);
		}

		if (search && search.length > 0) {
			results = search;
		}
	});

	// Check for details query errors
	$effect(() => {
		const queries = detailsQueries;
		if (queries.some((q) => q.error)) {
			toast.error('An error occurred while fetching media details!', {
				duration: 5000
			});
		}
	});

	// Extract details data
	const detailsData = $derived(
		detailsQueries.map((q) => q.data).filter((data): data is MediaDetails => data !== undefined)
	);
</script>

<div
	class="scrollbar-hide h-2/3 w-full overflow-auto rounded border border-white/10 bg-background-dark/80 p-2 shadow-sm backdrop-blur-2xl md:h-[350px] md:rounded-lg"
>
	{#each detailsData as data (`${data.mediaType}-${data.id}`)}
		<SearchResult media={data} />
	{/each}
</div>
