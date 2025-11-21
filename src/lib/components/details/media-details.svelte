<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import Poster from '$components/shared/poster.svelte';

	import Credits from './credits.svelte';
	import ReviewCard from './review-card.svelte';

	type Props = {
		media: MediaDetails;
		title: string;
		posterPath: string | null;
	};

	let { media, title, posterPath }: Props = $props();
</script>

<div
	class="relative z-10 mx-auto -mt-14 grid w-full grid-cols-3 md:-mt-44 md:grid-rows-2 lg:grid-cols-4 lg:grid-rows-none"
>
	<aside
		class="md-tablet:col-end-3 order-2 col-start-3 w-[95%] shrink-0 md:order-1 md:col-start-1 md:mt-0 md:mr-6 md:w-40 lg:col-end-2 lg:w-52 xl:mr-16 2xl:w-[230px]"
	>
		<Poster
			{title}
			src={posterPath ? posterPath : media.posterPath}
			fetchSize="w500"
			width={230}
			height={345}
			perspectiveEnabled={true}
			loading="eager"
			fetchPriority="high"
			classes=""
		/>
	</aside>

	<div
		class="order-1 col-start-1 col-end-3 flex h-fit grow basis-2/3 flex-col items-baseline px-2 pr-3 text-[#e9e2e3] md:order-2 md:col-start-2 md:col-end-5 md:px-0 md:pr-0 lg:col-start-2 lg:col-end-4 lg:row-start-1 lg:ml-0"
	>
		<Credits
			{title}
			director={media.mediaType === 'movie' && media.director}
			creator={media.mediaType === 'tv' ? media.creator : ''}
			releaseDate={media.releaseDate}
		/>

		<div
			class="col-start-1 col-end-4 row-start-2 mt-5 w-full md:order-3 md:mt-3 md:pr-6 lg:mt-6 lg:w-11/12 lg:pr-0 xl:w-4/5"
		>
			<h3 class="text-sm font-medium tracking-wide text-balance uppercase">
				{media.tagline}
			</h3>
			<p
				class="mt-2 hidden text-sm leading-normal font-medium tracking-wider text-pretty md:block md:text-base md:tracking-wide lg:mt-4"
			>
				{media.overview}
			</p>
		</div>
	</div>

	<p
		class="order-3 col-span-3 mx-auto mt-4 w-[95%] text-sm leading-normal font-medium tracking-wider text-pretty md:hidden"
	>
		{media.overview}
	</p>

	<div
		class="order-4 col-span-3 col-start-1 mx-auto mt-[52px] w-2/3 self-start md:w-[80%] lg:col-start-4"
	>
		<ReviewCard {media} />
	</div>
</div>
