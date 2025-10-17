<script lang="ts">
	import { resolve } from '$app/paths';

	type Props = {
		text: string;
		linkText: string;
		linkTo: '/login' | '/signup';
	};

	let { text, linkText, linkTo }: Props = $props();
</script>

<footer class="absolute right-0 bottom-6 left-0 text-center text-sm font-medium text-gray">
	<div class="gradient-border h-[1px] w-full"></div>
	<p class="mt-6">
		{text}
		<a href={resolve(linkTo)} class="cursor-pointer text-foreground">{linkText}</a>
		.
	</p>
</footer>
