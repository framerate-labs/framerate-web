<script lang="ts">
	import { createSearchParamsSchema, useSearchParams } from 'runed/kit';

	import Tooltip from '$components/shared/tooltip.svelte';
	import { TooltipProvider } from '$components/ui/tooltip';
	import { shortcut } from '$lib/utils/keyboard';

	type FilterValue = 'film' | 'series' | '';

	const schema = createSearchParamsSchema({
		filter: {
			type: 'string',
			default: '' as FilterValue
		}
	});

	const params = useSearchParams(schema, {
		pushHistory: false,
		noScroll: true,
		showDefaults: false
	});

	let filter = $derived(params.filter as FilterValue);

	// Type-safe setter
	function setFilter(value: FilterValue) {
		params.filter = value;
	}
</script>

<div class="flex justify-end gap-2 md:gap-3">
	<TooltipProvider>
		<Tooltip content="Show All" side="top" sideOffset={12} key1="A">
			<button
				use:shortcut={{ key: 'a' }}
				onclick={() => setFilter('')}
				class={[
					'library-filter-btn',
					filter === '' &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				All
			</button>
		</Tooltip>

		<Tooltip content="Show Films" side="top" sideOffset={12} key1="F">
			<button
				use:shortcut={{ key: 'f' }}
				onclick={() => setFilter('film')}
				class={[
					'library-filter-btn',
					filter === 'film' &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				Film
			</button>
		</Tooltip>

		<Tooltip content="Show Series" side="top" sideOffset={12} key1="S">
			<button
				use:shortcut={{ key: 's' }}
				onclick={() => setFilter('series')}
				class={[
					'library-filter-btn',
					filter === 'series' &&
						'background-highlight-gradient border border-transparent font-semibold text-foreground'
				]}
			>
				Series
			</button>
		</Tooltip>
	</TooltipProvider>
</div>
