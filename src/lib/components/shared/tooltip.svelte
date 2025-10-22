<script lang="ts">
	import type { Snippet } from 'svelte';

	import { Tooltip, TooltipContent, TooltipTrigger } from '$components/ui/tooltip';

	let {
		side = 'top',
		sideOffset = 0,
		content,
		key1,
		key2,
		isEnabled = undefined,
		classes = '',
		children
	}: {
		side?: 'top' | 'right' | 'bottom' | 'left';
		sideOffset?: number;
		content: Snippet | string;
		key1?: string;
		key2?: string;
		isEnabled?: boolean;
		classes?: string;
		children: Snippet;
	} = $props();
</script>

<Tooltip open={isEnabled}>
	<TooltipTrigger>
		{@render children()}
	</TooltipTrigger>
	<TooltipContent {side} {sideOffset} class="slide-in-from-bottom-2 {classes}">
		<div class="text-sm font-semibold tracking-wide">
			{content}
			{#if key1}
				<span class={key1 && key2 ? 'pl-3.5' : key1 && !key2 ? 'pl-2' : ''}></span>
				<span class="rounded bg-background-dark px-1 py-[1px] text-xs">
					{key1}
				</span>
			{/if}
			{#if key2}
				<span> then </span>
				<span class="rounded bg-background-dark px-1 py-[1px] text-xs">
					{key2}
				</span>
			{/if}
		</div>
	</TooltipContent>
</Tooltip>
