<script lang="ts">
	import X from '@lucide/svelte/icons/x';

	import { resolve } from '$app/paths';

	import { authClient } from '$lib/auth-client';

	const session = authClient.useSession();
	const isDemo = $derived($session.data?.user?.username === 'demo');

	let dismissed = $state(false);

	function dismiss() {
		dismissed = true;
	}
</script>

{#if isDemo && !dismissed}
	<div
		class="fixed top-0 right-0 left-0 z-50 animate-fade-in border-b border-amber-500/20 bg-amber-600/90 px-4 py-2.5 shadow-md backdrop-blur-sm"
	>
		<div class="mx-auto flex max-w-5xl items-center justify-between gap-4">
			<p class="text-sm font-medium text-white">
				You're exploring the demo account.
				<a
					href={resolve('/signup')}
					onclick={dismiss}
					class="ml-2 font-semibold underline decoration-white/50 underline-offset-2 transition-colors hover:text-amber-100 hover:decoration-amber-100"
				>
					Create your free account
				</a>
				to save your own ratings and collections.
			</p>
			<button
				onclick={dismiss}
				class="shrink-0 text-white transition-colors hover:text-amber-100"
				aria-label="Dismiss banner"
			>
				<X size={18} />
			</button>
		</div>
	</div>
{/if}
