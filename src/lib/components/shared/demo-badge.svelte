<script lang="ts">
	import { authClient } from '$lib/auth-client';

	const session = authClient.useSession();
	const isDemo = $derived($session.data?.user?.username === 'demo');
</script>

{#if isDemo}
	<div
		class="fixed top-0 right-0 left-0 z-40 mx-auto ml-auto w-full max-w-md md:max-w-2xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-[1200px]"
	>
		<div
			class="float-right flex w-fit animate-fade-in items-center justify-start gap-2 rounded-b border-r border-b border-l border-amber-600 bg-background-dark/60 px-4 py-1 shadow-md backdrop-blur-sm"
		>
			<div class="size-1 rounded-full bg-amber-600"></div>
			Demo
		</div>
	</div>
{/if}
