<script lang="ts">
	type Props = {
		title: string;
		description: string;
	};

	let { title, description }: Props = $props();
</script>

<section>
	<h1
		class="mb-1.5 bg-gradient-to-r from-[#9370db] to-[#f4b541] bg-clip-text text-center text-[28px] font-extrabold text-transparent"
	>
		{title}
	</h1>
	<p class="mx-auto mb-7 w-72 text-center text-sm font-medium tracking-wide text-gray">
		{description}
	</p>
</section>
