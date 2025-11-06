<script lang="ts">
	import type { Snippet } from 'svelte';

	import * as AlertDialog from '$components/ui/alert-dialog/index';

	type Props = {
		dialogContent: Snippet;
		dialogTrigger: Snippet;
		description: string;
		footerContent?: Snippet;
		title: string;
		open?: boolean;
	};

	let {
		dialogContent,
		dialogTrigger,
		description,
		footerContent,
		title,
		open = $bindable(false)
	}: Props = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		{@render dialogTrigger()}
	</AlertDialog.Trigger>

	<AlertDialog.Content
		class="border border-white/5 bg-background p-6 caret-foreground outline-none"
	>
		<AlertDialog.Header class="mb-1">
			<AlertDialog.Title class={[description ? 'mb-2' : '', 'text-foreground']}>
				{title}
			</AlertDialog.Title>
			<AlertDialog.Description class="sr-only">{description}</AlertDialog.Description>
		</AlertDialog.Header>
		{@render dialogContent()}

		{#if footerContent}
			<AlertDialog.Footer>
				{@render footerContent()}
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
