<script lang="ts">
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { createList } from '$services/lists';
	import { onClickOutside } from 'runed';
	import { toast } from 'svelte-sonner';
	import { superForm } from 'sveltekit-superforms';
	import { zod4 } from 'sveltekit-superforms/adapters';
	import { z } from 'zod';

	import PlusIcon from '$components/icons/plus-icon.svelte';
	import * as Form from '$components/ui/form/index';
	import { listSchema } from '$schema/list';

	type ListForm = z.infer<typeof listSchema>;

	const queryClient = useQueryClient();

	let isExpanded = $state(false);
	let lastSuccessTime = $state(0);

	let container = $state<HTMLElement>()!;
	let inputRef = $state<HTMLInputElement>()!;

	const createListMutation = createMutation(() => ({
		mutationFn: (name: string) => createList(name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['lists'] });
			toast.success('List created successfully');
			lastSuccessTime = Date.now();
		},
		onError: () => {
			toast.error('Failed to create list. Please try again later.');
		}
	}));

	const form = superForm<ListForm>(
		{ listName: '' },
		{
			validators: zod4(listSchema)
		}
	);

	const { form: formData, reset, validateForm } = form;

	async function handleSubmit() {
		const result = await validateForm();
		if (!result.valid) {
			form.errors.set({ listName: ['Please enter a valid name'] });
			return;
		}

		const listName = $formData.listName;
		createListMutation.mutate(listName);
	}

	$effect(() => {
		if (lastSuccessTime > 0) {
			reset();
			isExpanded = false;
		}
	});

	function toggleExpanded() {
		isExpanded = !isExpanded;
	}

	$effect(() => {
		if (isExpanded && inputRef) {
			inputRef.focus();
		}
	});

	onClickOutside(
		() => container,
		() => {
			if (isExpanded) {
				isExpanded = false;
				reset();
			}
		}
	);
</script>

<form class="mb-2.5" onsubmit={handleSubmit}>
	<Form.Field {form} name="listName" class="mb-2.5 space-y-0">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label class="sr-only">Collection Name</Form.Label>
				<label
					{...props}
					bind:this={container}
					class={[
						isExpanded ? 'w-full' : '',
						'mb-2.5 flex w-fit cursor-pointer items-center transition-colors duration-150 ease-in-out'
					]}
				>
					<button
						type="button"
						onclick={!isExpanded ? toggleExpanded : undefined}
						class="cursor-pointer"
					>
						<PlusIcon fillPrimary={isExpanded ? '#00e4f5' : '#d4d4d8'} fillSecondary="#262626" />
					</button>

					{#if !isExpanded}
						<span class="ml-1.5 select-none">Create collection</span>
					{:else}
						<div class="flex grow animate-scale-to-right">
							<input
								bind:this={inputRef}
								bind:value={$formData.listName}
								name="listName"
								type="text"
								autocomplete="off"
								disabled={createListMutation.isPending}
								class="relative ml-1 h-8 w-5/6 rounded rounded-r-none border border-r-0 border-white/5 bg-background-light pr-1 pl-2 text-[15px] leading-8 outline-none md:pr-2"
							/>
							<Form.Button
								disabled={createListMutation.isPending}
								class="h-8 overflow-x-scroll rounded rounded-tl-none rounded-bl-none border border-l-0 border-white/5 bg-background-light pr-2 pl-1 text-sm font-medium text-foreground transition-colors duration-150 ease-in outline-none hover:bg-background-light hover:text-[#00e4f5] disabled:cursor-not-allowed disabled:opacity-50 md:pl-2"
							>
								{createListMutation.isPending ? 'Creating...' : 'Create'}
							</Form.Button>
						</div>
					{/if}
				</label>
			{/snippet}
		</Form.Control>
		<Form.Description class="sr-only"
			>This is the name of the list where you will save movies and TV shows.</Form.Description
		>
		<Form.FieldErrors />
	</Form.Field>
</form>
