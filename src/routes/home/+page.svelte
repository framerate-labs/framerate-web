<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { getTrending } from '$services/trending';

	import HomeCarouselSkeleton from '$components/home/home-carousel-skeleton.svelte';
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
	{#if movieQuery.isError || tvQuery.isError}
		<div
			class="mx-auto mt-12 max-w-lg rounded-md border border-white/10 bg-background-dark p-6 text-center"
		>
			<p class="text-base font-medium">We couldn't load trending items right now.</p>
			<p class="mt-2 text-sm text-white/70">Please refresh the page or try again later.</p>
		</div>
	{:else if movieQuery.isSuccess && tvQuery.isSuccess}
		<HomeCarousel trendingMovies={movieQuery.data} trendingTv={tvQuery.data} />
	{/if}
</main>
