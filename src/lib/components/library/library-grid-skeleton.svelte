<section class="mt-4 pb-20">
	<div class="min-h-screen w-full rounded-md bg-background-dark p-3 md:px-7 md:py-8">
		<div class="grid grid-cols-3 gap-2 md:grid-cols-4 md:gap-3 lg:grid-cols-6">
			{#each Array.from({ length: 24 }), i (i)}
				<div
					class="h-[165px] w-[110px] animate-pulse rounded bg-white/[0.06] md:h-[225px] md:w-[150px] lg:h-[213px] lg:w-[143px] xl:h-[264px] xl:w-44"
				></div>
			{/each}
		</div>
	</div>
</section>
