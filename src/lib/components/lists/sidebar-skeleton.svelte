<nav
	class="sticky top-10 flex w-full grow animate-fade-in flex-col gap-4 overflow-x-hidden overflow-y-auto rounded-lg bg-background-dark px-3 py-5"
>
	<div class="mb-2 h-5 w-1/2 animate-pulse rounded bg-white/10"></div>
	<div class="space-y-2">
		{#each Array.from({ length: 8 }), index (index)}
			<div class="flex items-center justify-between">
				<div class="h-4 w-2/3 animate-pulse rounded bg-white/10"></div>
				<div class="h-8 w-1 rounded bg-white/10"></div>
			</div>
		{/each}
	</div>
</nav>
