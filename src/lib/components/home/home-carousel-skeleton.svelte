<div class="space-y-8">
	{#each Array(2) as i (i)}
		<section class="space-y-3">
			<div class="h-6 w-40 animate-pulse rounded bg-white/10"></div>
			<div class="flex gap-3 overflow-hidden">
				{#each Array(8) as i (i)}
					<div
						class="h-40 w-[110px] animate-pulse rounded bg-white/10 md:h-[195px] md:w-[140px] lg:h-[245px] lg:w-[165px]"
						aria-hidden="true"
					></div>
				{/each}
			</div>
		</section>
	{/each}
</div>
