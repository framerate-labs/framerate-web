<script lang="ts">
	type Props = {
		title: string;
		director?: string | false;
		creator?: string | false;
		releaseDate: Date | null;
	};

	let { title, director, creator, releaseDate }: Props = $props();

	const year = $derived(() => {
		if (!releaseDate) return '';
		// If it's a Date object, get the year
		if (releaseDate instanceof Date) return releaseDate.getFullYear().toString();
		return '';
	});

	const roleLabel = $derived(director ? 'Directed by ' : creator ? 'Created by ' : '');
	const person = $derived(director || creator || '');
</script>

<h2
	class="font-bespoke text-2xl leading-tight font-bold tracking-tight md:text-4xl md:leading-normal"
>
	{title}
</h2>
<div class="mt-3 text-sm md:mt-2.5 md:text-xl">
	{#if year()}
		<span class="pr-2 text-sm md:text-base">
			{year()}
		</span>
	{/if}
	{#if roleLabel}
		<span class="tracking-wide md:text-base">
			{roleLabel}
			<span class="font-medium md:inline-block md:text-base">
				{person}
			</span>
		</span>
	{/if}
</div>
