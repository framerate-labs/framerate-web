<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { injectSpeedInsights } from '@vercel/speed-insights/sveltekit';

	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { page } from '$app/state';

	let { data, children } = $props();

	injectSpeedInsights();

	const pathname = $derived(page.url.pathname);
	const basePaddingClass = $derived(
		pathname.includes('film') || pathname.includes('series') ? 'py-0' : 'px-2 py-4'
	);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>FrameRate</title>
	<meta
		name="description"
		content="FrameRate is the ultimate social platform for movie and TV enthusiasts. Share your reviews, create and discover lists, and effortlessly track everything you've watched!"
	/>
</svelte:head>

<QueryClientProvider client={data.queryClient}>
	<div
		class={[
			pathname === '/' ? 'bg-background-landing' : 'bg-background',
			basePaddingClass,
			'flex min-h-screen flex-col font-manrope antialiased md:px-6 md:py-0'
		]}
	>
		<main
			class="relative mx-auto flex w-full max-w-md flex-1 flex-col md:max-w-2xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-[1200px]"
		>
			{@render children?.()}
		</main>
	</div>
</QueryClientProvider>
