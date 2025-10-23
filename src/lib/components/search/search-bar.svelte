<script lang="ts">
	import { onDestroy } from 'svelte';

	let {
		searchQuery = $bindable(''),
		placeholder = 'Search across film and tv'
	}: {
		searchQuery: string;
		placeholder?: string;
	} = $props();

	// Clear search query on unmount
	onDestroy(() => {
		searchQuery = '';
	});
</script>

<label for="search" class="sr-only">Search</label>
<input
	id="search"
	name="search"
	{placeholder}
	bind:value={searchQuery}
	class="h-11 w-full rounded border border-white/10 bg-background-dark/80 px-5 font-medium backdrop-blur-xl outline-none placeholder:tracking-wide placeholder:text-white/35 md:order-2 md:rounded-lg"
/>
