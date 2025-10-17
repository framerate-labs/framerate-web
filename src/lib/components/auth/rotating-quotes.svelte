<script lang="ts">
	let currentIndex = $state(0);

	const quotes = [
		"There's no place like home",
		"We've been expecting you",
		"This is an offer you can't refuse",
		"So, you've come at last",
		'This is the way',
		"Where we're going, we don't need roads",
		'My precious...'
	];

	// Rotates the current quote
	$effect(() => {
		if (currentIndex === quotes.length) {
			currentIndex = 0;
		}

		const interval = setInterval(() => {
			currentIndex = currentIndex + 1;
		}, 4500);

		return () => {
			clearInterval(interval);
		};
	});
</script>

<span class="block text-center text-[26px] font-medium">
	{quotes[currentIndex]}
</span>
