<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import { userStore } from '$stores/user-store.svelte';

	let { title }: { title?: string } = $props();

	const isHomePath = $derived(page.url.pathname === '/home');
	const name = $derived(userStore.name);
	const greetingReady = $derived(userStore.status === 'ready');
</script>

<header class="flex h-24 items-center justify-between md:h-[115px]">
	<div class="flex flex-col justify-center gap-3 md:flex-row md:items-center">
		<a
			href={resolve('/home')}
			class="mr-2 flex flex-col items-center text-xl leading-5 md:text-2xl"
		>
			<span class="font-semibold">FrameRate</span>
		</a>
		<div>
			<h1 class="text-lg font-semibold md:text-xl">
				{#if isHomePath && greetingReady}
					{'Hello, ' + name}
				{:else}
					{title}
				{/if}
			</h1>
		</div>
	</div>
</header>
