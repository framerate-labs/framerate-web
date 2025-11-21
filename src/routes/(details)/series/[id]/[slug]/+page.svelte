<script lang="ts">
	import type { PageProps } from './$types';

	import { createQuery } from '@tanstack/svelte-query';
	import { getDetails } from '$services/details';

	import Backdrop from '$components/details/backdrop.svelte';
	import MediaDetails from '$components/details/media-details.svelte';

	let { data }: PageProps = $props();

	const query = createQuery(() => ({
		queryKey: ['tv-details', data.seriesId],
		queryFn: () => getDetails('tv', data.seriesId),
		staleTime: 60 * 1000 * 2,
		gcTime: 60 * 1000 * 5
	}));

	const series = $derived(query.data);
	const pageTitle = $derived.by(() => {
		const releaseDateString = series?.releaseDate ? `(${series.releaseDate.getFullYear()})` : '';
		return series ? `${series.title} ${releaseDateString} - FrameRate` : 'FrameRate';
	});

	const pageDescription = $derived(
		series?.overview
			? series.overview.length > 160
				? series.overview.substring(0, 157) + '...'
				: series.overview
			: 'Series details on FrameRate'
	);
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
</svelte:head>

{#if query.isSuccess}
	{@const movie = query.data}
	<div class="relative isolate pb-32">
		<Backdrop alt={`Still image from ${movie.title}`} backdropPath={movie.backdropPath ?? ''} />
		<MediaDetails media={movie} title={movie.title} posterPath={movie.posterPath ?? ''} />
	</div>
{/if}
