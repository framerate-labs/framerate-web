<div class="grid w-full grid-cols-3 gap-2 md:grid-cols-4 lg:grid-cols-5 lg:gap-3.5">
	{#each Array.from({ length: 15 }), index (index)}
		<div class="relative block rounded">
			<div
				class="h-[165px] w-[110px] animate-pulse rounded bg-white/6 md:h-[225px] md:w-[150px] lg:h-[213px] lg:w-[143px] xl:h-[264px] xl:w-44"
			></div>
		</div>
	{/each}
</div>
