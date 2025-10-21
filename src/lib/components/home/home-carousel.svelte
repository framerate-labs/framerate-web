<script lang="ts">
	import type { Trending } from '$types/trending';

	import { slugify } from '$utils/strings';

	import { resolve } from '$app/paths';

	import Poster from '$components/shared/poster.svelte';
	import * as Carousel from '$components/ui/carousel/index.js';

	type Props = {
		trendingMovies: Trending<'movie'>[];
		trendingTv: Trending<'tv'>[];
	};

	let { trendingMovies, trendingTv }: Props = $props();

	const groupedData = $derived([
		{
			type: 'movie' as const,
			title: 'Movies Making Waves',
			link: '/films/[id]/[slug]' as const,
			data: trendingMovies
		},
		{
			type: 'tv' as const,
			title: 'Series Sensations',
			link: '/series/[id]/[slug]' as const,
			data: trendingTv
		}
	]);
</script>

<div class="animate-fade-in">
	{#each groupedData as group (group.title)}
		{@const { data } = group}

		<section class="carousel-container group/trending">
			<h2 class="mb-3 ml-2 text-lg font-medium">{group.title}</h2>
			<Carousel.Root
				opts={{
					startIndex: 0,
					skipSnaps: true
				}}
			>
				<Carousel.Content>
					{#each data as media, index (media.id)}
						{@const titleSlug = slugify(media.title)}
						{@const loadingStrategy = index < 7 ? 'eager' : 'lazy'}
						{@const fetchStrategy = index < 7 ? 'high' : 'low'}

						<Carousel.Item class="basis-auto">
							<a
								href={resolve(
									//@ts-expect-error Union type issue with resolve
									group.link,
									{
										id: String(media.id),
										slug: titleSlug
									}
								)}
							>
								<Poster
									title={media.title}
									src={media.posterPath}
									fetchSize="w342"
									width={160}
									height={240}
									perspectiveEnabled={false}
									scale={105}
									loading={loadingStrategy}
									fetchPriority={fetchStrategy}
									classes="w-fit aspect-[2/3] h-[160px] md:h-[195px] lg:h-[245px]"
								/>
							</a>
						</Carousel.Item>
					{/each}
				</Carousel.Content>
				<Carousel.Previous
					class="group/trending hidden animate-fade-in md:group-hover/trending:flex"
				/>
				<Carousel.Next class="group/trending hidden animate-fade-in md:group-hover/trending:flex" />
			</Carousel.Root>
		</section>
	{/each}
</div>
