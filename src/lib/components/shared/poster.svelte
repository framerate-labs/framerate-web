<script lang="ts">
	interface Props {
		title: string;
		src: string | null;
		fetchSize: string;
		width: number;
		height: number;
		perspectiveEnabled: boolean;
		scale?: number;
		loading: 'eager' | 'lazy';
		fetchPriority: 'high' | 'low' | 'auto';
		classes: string;
	}

	let {
		title,
		fetchSize,
		src,
		width,
		height,
		perspectiveEnabled,
		scale,
		loading,
		fetchPriority,
		classes
	}: Props = $props();

	let imageLoaded = $state(false);
	let boundingRef: DOMRect | null;
	// svelte-ignore non_reactive_update
	let imageRef: HTMLImageElement | null;

	let perspectiveClasses = $derived(
		perspectiveEnabled
			? 'group rounded relative transform-gpu transition-transform ease-out hover:[transform:rotateX(var(--x-rotation))_rotateY(var(--y-rotation))]'
			: ''
	);

	const handleMouseEnter = perspectiveEnabled
		? (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
				boundingRef = event.currentTarget.getBoundingClientRect();
			}
		: undefined;
	const handleMouseLeave = perspectiveEnabled ? () => (boundingRef = null) : undefined;
	const handleMouseMove = perspectiveEnabled
		? (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
				if (!boundingRef) return;
				const x = event.clientX - boundingRef.left;
				const y = event.clientY - boundingRef.top;
				const xPercentage = x / boundingRef.width;
				const yPercentage = y / boundingRef.height;
				// converts the positions into degrees
				// x needs to be subtracted from 0.5 so all corners have the same behavior
				const xRotation = (0.5 - xPercentage) * 20;
				const yRotation = (yPercentage - 0.5) * 20;
				// x needs to rotate vertically so apply yRotation
				// y needs to rotate horizontally so apply xRotation
				event.currentTarget.style.setProperty('--x-rotation', `${yRotation}deg`);
				event.currentTarget.style.setProperty('--y-rotation', `${xRotation}deg`);
				event.currentTarget.style.setProperty('--x', `${xPercentage * 100}%`);
				event.currentTarget.style.setProperty('--y', `${yPercentage * 100}%`);
			}
		: undefined;

	function handleImageLoad() {
		imageLoaded = true;
	}

	// Check if image is already complete (for cached images)
	$effect(() => {
		if (imageRef && imageRef.complete) {
			imageLoaded = true;
		}

		// Add a fallback timer for any edge cases
		const timer = setTimeout(() => {
			imageLoaded = true;
		}, 1000);

		return () => clearTimeout(timer);
	});
</script>

<div
	class={[
		'w-fit transform-gpu transition-transform duration-200 ease-out [perspective:800px]',
		scale === 105 ? 'hover:scale-105' : 'hover:scale-[1.08]'
	]}
>
	<div
		role="presentation"
		aria-label="Interactive parallax background"
		onmouseenter={handleMouseEnter}
		onmouseleave={handleMouseLeave}
		onmousemove={handleMouseMove}
		class={perspectiveClasses}
	>
		{#if src}
			<img
				bind:this={imageRef}
				src={`https://image.tmdb.org/t/p/${fetchSize}${src}`}
				alt={`Poster for ${title}`}
				{width}
				{height}
				decoding="async"
				fetchpriority={fetchPriority}
				referrerPolicy="no-referrer"
				onload={handleImageLoad}
				{loading}
				draggable={false}
				class={`${classes} ${imageLoaded ? 'animate-fade-in' : 'opacity-0'} peer relative top-0 rounded object-cover drop-shadow select-none`}
			/>
		{/if}
		{#if !imageLoaded}
			<div
				aria-hidden={true}
				class="absolute inset-0 top-0 animate-pulse rounded bg-white/10 xl:h-[264px] xl:w-44"
			></div>
		{/if}
		<!-- The radial gradient is positioned according to mouse position -->
		<div
			class="pointer-events-none absolute inset-0 rounded drop-shadow group-hover:bg-[radial-gradient(at_var(--x)_var(--y),rgba(255,255,255,0.1)_15%,transparent_70%)]"
		></div>
	</div>
</div>
