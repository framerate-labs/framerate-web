<script lang="ts">
	import type { PageProps } from './$types';

	import { createQuery } from '@tanstack/svelte-query';
	import { getDetails } from '$services/details';

	import Backdrop from '$components/details/backdrop.svelte';
	import MediaDetails from '$components/details/media-details.svelte';

	let { data }: PageProps = $props();

	const query = createQuery(() => ({
		queryKey: ['movie-details', data.movieId],
		queryFn: () => getDetails('movie', data.movieId),
		staleTime: 60 * 1000 * 2,
		gcTime: 60 * 1000 * 5
	}));

	const movie = $derived(query.data);
	const pageTitle = $derived.by(() => {
		const releaseDateString = movie?.releaseDate ? `(${movie.releaseDate.getFullYear()})` : '';
		return movie ? `${movie.title} ${releaseDateString} - FrameRate` : 'FrameRate';
	});

	const pageDescription = $derived(
		movie?.overview
			? movie.overview.length > 160
				? movie.overview.substring(0, 157) + '...'
				: movie.overview
			: 'Movie details on FrameRate'
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
