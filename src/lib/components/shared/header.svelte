<script lang="ts">
	import LogOut from '@lucide/svelte/icons/log-out';

	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import { TooltipProvider } from '$components/ui/tooltip';
	import { authClient } from '$lib/auth-client';
	import { userStore } from '$stores/user-store.svelte';

	import Tooltip from './tooltip.svelte';

	let { title }: { title?: string } = $props();

	const isHomePath = $derived(page.url.pathname === '/home');
	const name = $derived(userStore.name);
	const greetingReady = $derived(userStore.status === 'ready');

	const session = authClient.useSession();
	const user = $derived($session.data?.user);

	async function handleLogOut() {
		userStore.clearUser();
		await authClient.signOut();
		window.location.href = '/';
	}
</script>

<header class="flex h-24 items-center justify-between md:h-[125px]">
	<div class="flex flex-col justify-center gap-3 md:flex-row md:items-center">
		<a
			href={resolve('/home')}
			class="mr-2 flex flex-col items-start text-xl leading-5 md:items-center md:text-2xl"
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

	{#if user}
		<TooltipProvider>
			<Tooltip content="Log out" side="bottom" sideOffset={14}>
				<LogOut strokeWidth={1.5} size={18} onclick={handleLogOut} class="cursor-pointer" />
			</Tooltip>
		</TooltipProvider>
	{/if}
</header>
