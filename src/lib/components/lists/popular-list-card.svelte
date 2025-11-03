<script lang="ts">
	import type { PopularList } from '$types/lists';

	import { resolve } from '$app/paths';

	import PopularListPreview from './popular-list-preview.svelte';

	interface Props {
		list: PopularList;
	}

	let { list }: Props = $props();

	let username = $derived(list.username);
	let slug = $derived(list.slug);
	let name = $derived(list.name);
</script>

<a
	href={resolve('/[username]/collections/[slug]', { username, slug })}
	class="group relative flex flex-col overflow-hidden rounded-lg border border-white/10 bg-background transition-colors hover:bg-background-light/40"
>
	<div class="h-30 w-full md:h-36 lg:h-44">
		<PopularListPreview {username} {slug} />
	</div>
	<div class="flex h-full grow flex-col items-start justify-between p-3">
		<h3 class="line-clamp-2 text-sm font-semibold text-foreground group-hover:text-white">
			{name}
		</h3>
		<p class="mt-2 text-sm text-white/60">@{username}</p>
	</div>
</a>
