<script lang="ts">
	import type { ListItem } from '$types/lists';
	import type { Review } from '$types/ratings';

	import { resolve } from '$app/paths';

	import StarIcon from '$components/icons/star-icon.svelte';
	import Poster from '$components/shared/poster.svelte';
	import Tooltip from '$components/shared/tooltip.svelte';
	import { TooltipProvider } from '$components/ui/tooltip';
	import { slugify } from '$lib/utils/strings';

	type Props = {
		mediaArray: ListItem[] | Review<'movie' | 'tv'>[];
		isTooltipEnabled?: boolean;
		classes: string;
	};

	let { mediaArray, isTooltipEnabled: isEnabled, classes }: Props = $props();

	const filmRoute = '/films/[id]/[slug]';
	const seriesRoute = '/series/[id]/[slug]';
</script>

<div class={[classes, 'animate-fade-in-fast grid']}>
	{#if mediaArray.length > 0}
		{#each mediaArray as media, index (media.mediaId)}
			{@const route = media.mediaType === 'movie' ? filmRoute : seriesRoute}
			{@const titleSlug = slugify(media.title)}
			{@const rating = 'rating' in media && parseFloat(media.rating)}
			{@const loadStrategy = index < 18 ? 'eager' : 'lazy'}
			{@const fetchStrategy = index < 18 ? 'high' : 'low'}

			<!-- Tooltip Content -->
			{#snippet content()}
				<div class="max-w-48">
					<div class="w-full">
						<p class="font-semibold tracking-wide">{media.title}</p>
						<div class="my-1 flex justify-start">
							<StarIcon fill="#FFD43B" classes="h-4 w-4" />
							<span class="ml-1 font-semibold">{rating}</span>
						</div>
					</div>
				</div>
			{/snippet}

			<TooltipProvider>
				<Tooltip
					sideOffset={25}
					side="bottom"
					{content}
					{isEnabled}
					classes="bg-background-light border-white/10"
				>
					<a
						href={resolve(
							//@ts-expect-error Union type issue with resolve
							route,
							{ id: String(media.mediaId), slug: titleSlug }
						)}
						class="relative block rounded"
					>
						<Poster
							title={media.title}
							src={media.posterPath}
							fetchSize="w342"
							width={160}
							height={240}
							perspectiveEnabled={true}
							loading={loadStrategy}
							fetchPriority={fetchStrategy}
							classes="h-[165px] w-[110px] lg:w-[143px] lg:h-[213px] xl:h-[264px] xl:w-44"
						/>
					</a>
				</Tooltip>
			</TooltipProvider>
		{/each}
	{/if}
</div>
