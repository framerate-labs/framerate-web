<script lang="ts">
	import type { Review } from '$types/ratings';

	import ArrowUp from '@lucide/svelte/icons/arrow-up';

	import { page } from '$app/state';

	import LibraryFilters from '$components/library/library-filters.svelte';
	import PosterGrid from '$components/shared/poster-grid.svelte';
	import Tooltip from '$components/shared/tooltip.svelte';
	import { TooltipProvider } from '$components/ui/tooltip';

	// import { scrollToTop } from '$lib/scroll';

	type Props = {
		fetchedReviews: Review<'movie' | 'tv'>[];
	};

	let { fetchedReviews }: Props = $props();

	let isArrowVisible = $state(false);

	let scrollBtnRef: HTMLButtonElement | null = null;

	// useHotkeys('t', () => {
	//   scrollToTopBtn.current?.click();
	// });

	// useEffect(() => {
	//   let ticking = false;
	//   const onScroll = () => {
	//     if (!ticking) {
	//       window.requestAnimationFrame(() => {
	//         setIsArrowVisible(window.scrollY > 500);
	//         ticking = false;
	//       });
	//       ticking = true;
	//     }
	//   };

	//   window.addEventListener('scroll', onScroll, { passive: true });
	//   return () => {
	//     window.removeEventListener('scroll', onScroll);
	//   };
	// }, []);

	let reviews = $derived.by(() => {
		const sorted = [...fetchedReviews].sort((a, b) => {
			const dateA = new Date(a.createdAt).getTime();
			const dateB = new Date(b.createdAt).getTime();
			return dateB - dateA;
		});

		if (page.url.searchParams.get('filter') === 'film')
			return sorted.filter((r) => r.mediaType === 'movie');
		if (page.url.searchParams.get('filter') === 'series')
			return sorted.filter((r) => r.mediaType === 'tv');

		return sorted;
	});
</script>

<div>
	<LibraryFilters />
</div>

<section class="animate-fade-in-fast mt-4 pb-20">
	{#if reviews.length === 0}
		<div class="mx-auto mt-32 text-center">
			<p class="text-lg font-medium">
				Log your first review to start building your personal library!
			</p>
		</div>
	{:else}
		<div class="min-h-screen w-full rounded-md bg-background-dark p-3 md:p-4 lg:p-6">
			<PosterGrid
				mediaArray={reviews}
				classes="gap-2 grid-cols-3 md:grid-cols-4 lg:grid-cols-6 md:gap-3"
			/>
		</div>
	{/if}

	<TooltipProvider>
		<Tooltip side="top" sideOffset={12} content="Scroll to top" key1="T">
			<button
				bind:this={scrollBtnRef}
				class={[
					isArrowVisible ? 'animate-fade-in opacity-100' : 'pointer-events-none opacity-0',
					'fixed right-4 bottom-4 rounded-full p-2 shadow-lg transition-colors duration-200 outline-none hover:bg-white/5'
				]}
				aria-label="Scroll to top"
			>
				<ArrowUp strokeWidth={1.5} />
			</button>
		</Tooltip>
	</TooltipProvider>
</section>
