<script lang="ts">
	type Props = {
		collection?: boolean;
		alt: string;
		backdropPath: string;
	};

	let { collection = false, alt, backdropPath }: Props = $props();

	let imageLoaded = $state(false);
	let imageError = $state(false);

	function handleImageLoad() {
		imageLoaded = true;
	}

	function handleImageError() {
		imageError = true;
	}

	const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original';
</script>

{#if backdropPath && !imageError}
	<div class="relative -z-10 m-auto h-auto w-full overflow-hidden">
		<img
			src={`${TMDB_IMAGE_BASE}${backdropPath}`}
			{alt}
			loading="lazy"
			decoding="async"
			width={1920}
			height={1080}
			onload={handleImageLoad}
			onerror={handleImageError}
			class={[
				imageLoaded ? 'animate-fade-in' : 'opacity-0',
				collection ? 'h-[450px]' : 'h-auto',
				'w-full object-cover'
			]}
		/>
		<!-- Tablet and Desktop shadow gradient -->
		<div
			class={[
				collection ? 'h-[550px]' : 'md:h-[455px] lg:h-[675px] xl:h-[700px]',
				'backdrop-fade pointer-events-none absolute top-0 hidden w-full bg-no-repeat md:block'
			]}
		></div>
		<!-- Mobile shadow gradient -->
		<div
			class="pointer-events-none absolute top-0 block size-full bg-gradient-to-t from-neutral-900 via-transparent to-transparent bg-no-repeat md:hidden"
		></div>
	</div>
{/if}
