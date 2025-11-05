<script lang="ts">
	import type { ListData } from '$types/lists';
	import type { RouteParams } from '../../../routes/[username]/collections/[slug]/$types';

	import { getElapsedTimeText } from '$utils/time';

	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	interface Props {
		listData: ListData;
	}

	let { listData }: Props = $props();

	const { username } = page.params as RouteParams;

	let displayData: ListData = $state();
	let isHovering = $state(false);

	// Keep UI in sync with server data after mutations
	$effect(() => {
		if (listData) {
			displayData = listData;
		}
	});
</script>

{#if displayData}
	<div class="mb-8">
		<h2 class="mb-1 text-lg leading-snug font-bold wrap-break-word whitespace-normal md:text-xl">
			{displayData.list.name}
		</h2>
		<h3 class="mb-0.5 text-sm font-medium text-gray md:text-base">
			Collection by
			<a
				href={resolve('/[username]', { username })}
				class="font-bold opacity-100 transition-colors duration-200"
			>
				{username}
			</a>
		</h3>

		<p
			onmouseenter={() => (isHovering = true)}
			onmouseleave={() => (isHovering = false)}
			class="text-medium relative h-5 w-fit cursor-default text-xs text-gray md:text-sm"
		>
			{getElapsedTimeText(isHovering, displayData.list)}
		</p>
	</div>
{/if}
