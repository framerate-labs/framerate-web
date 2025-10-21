<script lang="ts">
	import type { MediaDetails } from '$types/details';

	import { slugify } from '$utils/strings';

	import { resolve } from '$app/paths';

	import { DialogClose } from '$components/ui/dialog';

	let { media }: { media: MediaDetails } = $props();

	let title = $derived(media.title);
	let releaseDate = $derived(media.releaseDate);

	const titleSlug = media.title ? slugify(media.title) : '';
	const mediaType = media.mediaType === 'movie' ? 'films' : 'series';
	const route = `/${mediaType}/${String(media.id)}/${titleSlug}` as const;
</script>

{#if title && releaseDate}
	<DialogClose class="w-full">
		<a
			href={resolve(
				//@ts-expect-error Union type issue with resolve
				route,
				{
					id: media.id,
					slug: titleSlug
				}
			)}
			class="mt-0 flex w-full animate-fade-in items-center rounded-md py-1 hover:bg-background-dark md:py-2"
		>
			<div class="pointer-events-none mr-1.5 flex md:px-2">
				{#if media.posterPath}
					<img
						src={`https://image.tmdb.org/t/p/w92${media.posterPath}`}
						alt={`A promotional poster from ${title}`}
						width={92}
						height={138}
						class="aspect-[2/3] h-14 w-fit rounded-xs md:h-12 md:rounded"
					/>
				{/if}
			</div>
			<div class="flex flex-col items-baseline text-left">
				<p class="text-[15px] font-medium">
					{title} ({releaseDate.toString().slice(0, 4)})
				</p>
				<p
					class="text-xs font-semibold tracking-wide text-nowrap text-gray md:text-sm md:font-medium"
				>
					{media.mediaType === 'movie' ? media.director : media.creator}
				</p>
			</div>

			<!-- Badge -->
			<div class="mr-0.5 flex grow justify-end md:mr-4">
				<div class="rounded bg-background ring-2 ring-white/5">
					<p
						class="inline-block w-[61.33px] rounded bg-gradient-to-b from-neutral-100 via-neutral-100/80 to-neutral-100/30 bg-clip-text px-2 py-1 text-center text-sm text-transparent"
					>
						{media.mediaType === 'movie' ? 'Film' : 'Series'}
					</p>
				</div>
			</div>
		</a>
	</DialogClose>
{/if}
