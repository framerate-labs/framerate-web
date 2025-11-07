<script lang="ts">
	import type { ListSchema } from '$schema/list';
	import type { ListData } from '$types/lists';
	import type { Infer, SuperValidated } from 'sveltekit-superforms';

	import { useQueryClient } from '@tanstack/svelte-query';
	import { slugify } from '$utils/strings';
	import { toast } from 'svelte-sonner';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';

	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';

	import * as Form from '$components/ui/form/index';
	import { Input } from '$components/ui/input';
	import { listSchema } from '$schema/list';

	interface Props {
		returnSlug: string;
		data: {
			form: SuperValidated<Infer<ListSchema>>;
		};
		username: string;
		slug: string;
		listData: ListData;
	}

	let { data, username, slug, listData, returnSlug = $bindable() }: Props = $props();

	const queryClient = useQueryClient();

	const form = superForm(data.form, {
		validators: zod4Client(listSchema),
		onUpdated({ form }) {
			if (form.message) {
				if (form.message.type === 'success') {
					toast.success(form.message.text);

					// Remove old query (list no longer exists at old slug)
					queryClient.removeQueries({ queryKey: ['list-items', username, slug] });
					// Invalidate lists to refresh sidebar
					queryClient.invalidateQueries({ queryKey: ['lists'] });
				} else if (form.message.type === 'error') {
					toast.error(form.message.text);
				}
			}
		},
		onResult({ result }) {
			// Handle URL update after successful form submission
			if (result.type === 'success' && result.data?.newSlug) {
				const newSlug = result.data.newSlug;
				returnSlug = newSlug;

				// If slug didn't change, no history manipulation needed
				if (newSlug === slug) return;

				const newDetailPath = resolve('/[username]/collections/[slug]', {
					username,
					slug: newSlug
				});
				const newEditPath = resolve('/[username]/collections/[slug]/edit', {
					username,
					slug: newSlug
				});

				// Strategy: Rebuild history stack to have clean new-slug URLs
				// 1. Go back to detail page (old-slug)
				// 2. Replace it with detail (new-slug)
				// 3. Push edit (new-slug) - this discards forward history with old-slug

				let hasNavigatedBack = false;

				const handlePopState = () => {
					if (!hasNavigatedBack) {
						hasNavigatedBack = true;
						// We're now at detail (old-slug), replace it with new-slug
						goto(newDetailPath, { replaceState: true, noScroll: true }).then(() => {
							// Now push edit page with new slug
							goto(newEditPath, { keepFocus: true });
						});
					}
				};

				window.addEventListener('popstate', handlePopState, { once: true });

				// Start the process: go back to detail page
				window.history.go(-1);
			}
		}
	});

	const { form: formData, enhance } = form;
</script>

<form method="POST" use:enhance>
	{#if listData}
		<Form.Field {form} name="listName">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label class="mb-4">Collection Name</Form.Label>
					<Input
						{...props}
						bind:value={$formData.listName}
						placeholder={listData.list.name}
						autocomplete="off"
						autofocus
						class="block w-full rounded-md bg-background-light px-3.5 py-2 text-foreground outline-none placeholder:text-white/35"
					/>
				{/snippet}
			</Form.Control>
			<Form.Description class="sr-only"
				>The new name of the list where you will save movies and TV shows.</Form.Description
			>
			<Form.FieldErrors />
		</Form.Field>
	{/if}

	<Form.Button
		class="float-right mt-2 cursor-pointer rounded border border-indigo-700 bg-indigo-600 px-4 py-1.5 font-semibold text-foreground hover:bg-indigo-700"
		>Save</Form.Button
	>
</form>
