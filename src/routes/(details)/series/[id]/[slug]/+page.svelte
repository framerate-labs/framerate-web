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

	let pageTitle = $derived(query.data?.title ?? 'FrameRate');
	let pageDescription = $derived(query.data?.overview ?? 'Series Details');
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
