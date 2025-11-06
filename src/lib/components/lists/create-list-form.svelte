<script lang="ts">
	import type { ListSchema } from '$schema/list';
	import type { Infer, SuperValidated } from 'sveltekit-superforms';

	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';

	import Input from '$components/ui/input/input.svelte';
	import * as Form from '$lib/components/ui/form/index';
	import { listSchema } from '$schema/list';

	interface Props {
		data: {
			form: SuperValidated<Infer<ListSchema>>;
		};
		onSuccess?: () => void;
	}

	let { data, onSuccess }: Props = $props();

	const queryClient = useQueryClient();

	const form = superForm(data.form, {
		validators: zod4Client(listSchema),
		onUpdated({ form }) {
			if (form.message) {
				if (form.message.type === 'success') {
					toast.success(form.message.text);
					queryClient.invalidateQueries({ queryKey: ['lists'] });
					onSuccess?.();
				} else if (form.message.type === 'error') {
					toast.error(form.message.text);
				}
			}
		}
	});

	const { form: formData, enhance } = form;
</script>

<form method="POST" use:enhance id="create-list-form">
	<Form.Field {form} name="listName">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label class="mb-4">Collection Name</Form.Label>
				<Input
					{...props}
					bind:value={$formData.listName}
					autocomplete="off"
					autofocus
					class="block w-full rounded-md bg-white/5 px-3.5 py-2 text-foreground outline-none placeholder:text-white/35"
				/>
			{/snippet}
		</Form.Control>
		<Form.Description class="sr-only"
			>This is the name of the list where you will save movies and TV shows.</Form.Description
		>
		<Form.FieldErrors />
	</Form.Field>
</form>
