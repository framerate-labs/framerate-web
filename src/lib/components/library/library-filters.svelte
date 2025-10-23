<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import Tooltip from '$components/shared/tooltip.svelte';
	import { TooltipProvider } from '$components/ui/tooltip';
	import { shortcut } from '$lib/utils/keyboard';

	let filter = $derived(page.url.searchParams.get('filter'));
</script>

<div class="flex justify-end gap-2 md:gap-3">
	<TooltipProvider>
		<Tooltip content="Show All" side="top" sideOffset={12} key1="A">
			<a
				use:shortcut={{ key: 'a' }}
				href={resolve('/library')}
				class={[
					'library-filter-btn',
					filter === null &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				All
			</a>
		</Tooltip>

		<Tooltip content="Show Films" side="top" sideOffset={12} key1="F">
			<a
				use:shortcut={{ key: 'f' }}
				href={resolve('/library?filter=film')}
				class={[
					'library-filter-btn',
					filter === 'film' &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				Film
			</a>
		</Tooltip>

		<Tooltip content="Show Series" side="top" sideOffset={12} key1="S">
			<a
				use:shortcut={{ key: 's' }}
				href={resolve('/library?filter=series')}
				class={[
					'library-filter-btn',
					filter === 'series' &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				Series
			</a>
		</Tooltip>
	</TooltipProvider>
</div>
