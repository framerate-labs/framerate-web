<script lang="ts">
	import type { Snippet } from 'svelte';

	import { Dialog as DialogPrimitive } from 'bits-ui';

	import { cn } from '$lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: DialogPrimitive.ContentProps & {
		children: Snippet;
	} = $props();
</script>

<DialogPrimitive.Portal>
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			'fixed top-2 right-0 left-0 z-50 mx-auto flex h-2/3 w-full grid-rows-[350px,_46px] flex-col gap-2.5 rounded px-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 md:top-auto md:bottom-2 md:grid md:h-auto md:w-[550px] 2xl:w-[600px]',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</DialogPrimitive.Content>
</DialogPrimitive.Portal>
