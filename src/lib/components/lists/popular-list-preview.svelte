<script lang="ts">
	import { browser } from '$app/environment';

	import { createQuery } from '@tanstack/svelte-query';
	import { getListData } from '$services/lists';

	interface Props {
		username: string;
		slug: string;
	}

	const CACHE_PREFIX = 'list-preview:';
	const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

	type CachedPreview = {
		posters: string[];
		expiresAt: number;
	};

	let { username, slug }: Props = $props();

	let posters = $state<string[]>([]);
	let previewContainer: HTMLDivElement | null = null;
	let isVisible = $state(false);
	let hasCachedData = $state(false);

	const cacheKey = $derived(`${CACHE_PREFIX}${username}:${slug}`);

	function readCachedPosters(key: string): string[] | null {
		if (!browser) return null;
		try {
			const raw = sessionStorage.getItem(key);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as CachedPreview;
			if (!Array.isArray(parsed.posters) || typeof parsed.expiresAt !== 'number') {
				sessionStorage.removeItem(key);
				return null;
			}
			if (parsed.expiresAt < Date.now()) {
				sessionStorage.removeItem(key);
				return null;
			}
			return parsed.posters;
		} catch {
			sessionStorage.removeItem(key);
			return null;
		}
	}

	function writeCachedPosters(key: string, value: string[]) {
		if (!browser) return;
		try {
			const payload: CachedPreview = {
				posters: value,
				expiresAt: Date.now() + CACHE_TTL_MS
			};
			sessionStorage.setItem(key, JSON.stringify(payload));
		} catch {
			// Ignore storage quota errors.
		}
	}

	function observeVisibility(node: HTMLDivElement | null) {
		if (!browser || !node) return;
		const observer = new IntersectionObserver(
			(entries, obs) => {
				const [entry] = entries;
				if (entry?.isIntersecting) {
					isVisible = true;
					obs.disconnect();
				}
			},
			{
				rootMargin: '150px'
			}
		);
		observer.observe(node);
		return () => observer.disconnect();
	}

	$effect(() => {
		if (!browser) return;
		const cached = readCachedPosters(cacheKey);
		if (cached && cached.length > 0) {
			posters = cached;
			hasCachedData = true;
		}
	});

	$effect(() => {
		if (!previewContainer) return;
		return observeVisibility(previewContainer);
	});

	const previewQuery = createQuery(() => ({
		queryKey: ['list-preview', username, slug],
		queryFn: () => getListData(username, slug),
		staleTime: 30 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		retry: 1,
		enabled: isVisible && !hasCachedData
	}));

	$effect(() => {
		const items = previewQuery.data?.listItems;
		if (!items || items.length === 0) return;

		const nextPosters = items
			.map((item) => item.posterPath)
			.filter(Boolean)
			.slice(0, 4) as string[];

		if (nextPosters.length === 0) return;

		posters = nextPosters;
		hasCachedData = true;
		writeCachedPosters(cacheKey, nextPosters);
	});
</script>

{#if previewQuery.isFetching && posters.length === 0}
	<div class="size-full shrink-0 animate-pulse bg-background-light"></div>
{:else if posters.length === 0 && previewQuery.error}
	<div
		class="flex size-full shrink-0 items-center justify-center bg-background-light text-center text-xs text-neutral-300"
	>
		Unable to load preview
	</div>
{:else if posters.length === 0}
	<div
		class="flex size-full shrink-0 items-center justify-center bg-background-light text-xs text-neutral-300"
	>
		No preview
	</div>
{/if}

<div
	bind:this={previewContainer}
	class="grid size-full shrink-0 grid-cols-2 grid-rows-2 gap-0.5 bg-background"
>
	{#each posters as posterSrc (posterSrc)}
		<img
			src={`https://image.tmdb.org/t/p/w185${posterSrc}`}
			alt="Grid featuring media poster images from the list."
			class="size-full object-cover"
			loading="lazy"
		/>
	{/each}
</div>
