<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { getAllReviews } from '$services/reviews';

	import { resolve } from '$app/paths';

	import LibraryGridSkeleton from '$components/library/library-grid-skeleton.svelte';
	import LibraryGrid from '$components/library/library-grid.svelte';
	import Header from '$components/shared/header.svelte';

	const libraryQuery = createQuery(() => ({
		queryKey: ['library'],
		queryFn: getAllReviews,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		retry: 2
	}));
</script>

<svelte:head>
	<title>My Library - FrameRate</title>
	<meta
		name="description"
		content="Your personal library of liked, watched, and saved movies and series. Filter and browse your collections on FrameRate."
	/>
</svelte:head>

<Header title="Library" />

<main class="animate-fade-in">
	{#if libraryQuery.isPending}
		<LibraryGridSkeleton />
	{:else if libraryQuery.isError}
		<div
			class="mx-auto mt-20 max-w-lg rounded-md border border-white/10 bg-background-dark p-6 text-center"
		>
			<p class="mb-4 text-base font-medium">Please log in to view your library.</p>
			<a
				href={resolve('/login')}
				class="inline-block rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10"
			>
				Go to Login
			</a>
		</div>
	{:else if libraryQuery.isSuccess}
		<LibraryGrid fetchedReviews={libraryQuery.data} />
	{/if}
</main>
