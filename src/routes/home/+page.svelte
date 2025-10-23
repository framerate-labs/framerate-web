<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { getTrending } from '$services/trending';

	import HomeCarousel from '$components/home/home-carousel.svelte';
	import Header from '$components/shared/header.svelte';

	const movieQuery = createQuery(() => ({
		queryKey: ['trending', 'movie', 'week'],
		queryFn: () => getTrending({ filter: 'movie', timeWindow: 'week' })
	}));

	const tvQuery = createQuery(() => ({
		queryKey: ['trending', 'tv', 'week'],
		queryFn: () => getTrending({ filter: 'tv', timeWindow: 'week' })
	}));
</script>

<Header />
<main class="min-h-[calc(100vh-var(--header-height))] animate-fade-in pb-14">
	{#if movieQuery.isSuccess && tvQuery.isSuccess}
		<HomeCarousel trendingMovies={movieQuery.data} trendingTv={tvQuery.data} />
	{/if}
</main>
