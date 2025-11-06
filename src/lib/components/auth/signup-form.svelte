<script lang="ts">
	import CircleArrowRight from '@lucide/svelte/icons/circle-arrow-right';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { createList } from '$services/lists';
	import { toast } from 'svelte-sonner';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import z4 from 'zod/v4';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	import * as Form from '$components/ui/form/index.js';
	import { Input } from '$components/ui/input/index.js';
	import { authClient } from '$lib/auth-client';
	import { blacklistChecks } from '$lib/utils/blacklist-check';
	import { signupSchema } from '$schema/auth-schema';

	type Props = {
		pageState: { page: number };
	};

	let { pageState }: Props = $props();

	const form = superForm(
		{ email: '', name: '', username: '', password: '' },
		{
			validators: zod4Client(signupSchema),
			onSubmit: ({ formData }) => {
				const data = Object.fromEntries(formData) as z4.infer<typeof signupSchema>;
				return handleSubmit(data);
			},
			resetForm: false
		}
	);

	const { form: formData, enhance, errors, validate } = form;

	let isVisible = $state(false);

	// Email validation before page change is necessary for UX
	// Otherwise, email input errors won't be visible to users
	// on page 2.
	async function validateEmail() {
		if (pageState.page === 1) {
			const errors = await validate('email');

			if (!errors) {
				pageState.page = 2;
			}
		} else {
			pageState.page = 1;
		}
	}

	$effect(() => {
		if (pageState.page === 2 && $errors.email) {
			pageState.page = 1;
		}
	});

	// Checks input against filters before creating user in DB
	async function handleSubmit(formData: z4.infer<typeof signupSchema>) {
		const result = blacklistChecks(formData);

		if (result.status === 'error') {
			toast.error(result.message);
			return;
		}

		if (result.status === 'success') {
			const { email, name, username, password } = formData;

			(async function signup() {
				await authClient.signUp.email(
					{
						email,
						name,
						username,
						password
					},
					{
						onRequest: () => {
							toast.loading('Creating account...', { id: 'signup' });
						},
						onSuccess: async () => {
							toast.dismiss('signup');
							toast.success('Account created!');

							const { data: sessionData } = await authClient.getSession();

							if (sessionData) {
								await createList('Watchlist');
							}

							await goto(resolve('/home'));
						},
						onError: (ctx) => {
							toast.dismiss('signup');
							const errorCode = ctx.error.code;
							const errorMessage = ctx.error.message;

							switch (errorCode) {
								case 'USERNAME_IS_ALREADY_TAKEN_PLEASE_TRY_ANOTHER':
									$errors.username = ['Username is taken'];
									toast.error('Username is already taken. Please try another one', {
										duration: 6000
									});
									break;
								case 'USER_ALREADY_EXISTS':
									$errors.email = ['Account already exists'];
									toast.error(
										'An account with this email already exists. Did you mean to log in?',
										{ duration: 6000 }
									);
									break;
								default:
									toast.error(errorMessage, { duration: 6000 });
									console.error(ctx.error);
							}
						}
					}
				);
			})();
		}
	}

	const groupedFields = [
		{
			fieldName: 'name' as const,
			label: 'Name',
			placeholder: 'your name (public)',
			description: 'Enter your name. It does not have to be your full name and will be public.'
		},
		{
			fieldName: 'username' as const,
			label: 'Username',
			placeholder: 'your username (public)',
			description: 'This is your public username.'
		}
	];
</script>

<form method="POST" use:enhance>
	<Form.Field {form} name="email" hidden={pageState.page !== 1}>
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label class="sr-only">Email</Form.Label>
				<div
					class={[
						'relative flex items-center rounded-full bg-white/[0.01] ring-1 ring-white/10',
						$errors.email && '!ring-red-500'
					]}
				>
					<Input
						{...props}
						bind:value={$formData.email}
						type="email"
						placeholder="account email"
						autocomplete="email"
						class="auth-input grow rounded-l-full rounded-r-none bg-transparent ring-0 ring-transparent"
					/>
					<button
						type="button"
						onclick={validateEmail}
						class={[
							'flex cursor-pointer flex-col items-center pr-2.5 text-gray transition-colors duration-200 hover:text-foreground',
							pageState.page === 2 ? 'hidden' : 'block'
						]}
					>
						<CircleArrowRight size={28} strokeWidth={1.1} />
					</button>
				</div>
			{/snippet}
		</Form.Control>
		<Form.Description class="sr-only"
			>This is the email you used to create your account.</Form.Description
		>
		<Form.FieldErrors class="mt-1 ml-6 max-w-80 font-medium text-wrap text-red-500" />
	</Form.Field>

	{#each groupedFields as fieldItem, i (fieldItem.fieldName)}
		{@const { fieldName, label, placeholder, description } = fieldItem}

		<Form.Field {form} name={fieldName} hidden={pageState.page !== 2}>
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label class="sr-only">{label}</Form.Label>
					<Input
						{...props}
						bind:value={$formData[fieldName]}
						type="text"
						{placeholder}
						autocomplete={fieldName}
						autofocus={fieldName === 'name'}
						class={['auth-input', $errors[fieldName] && 'ring-1 ring-red-500']}
					/>
				{/snippet}
			</Form.Control>
			<Form.Description class="sr-only">{description}</Form.Description>
			<Form.FieldErrors class="mt-1 mb-3 ml-6 max-w-80 font-medium text-wrap text-red-500" />
		</Form.Field>
	{/each}

	<Form.Field {form} name="password" class="mt-3" hidden={pageState.page !== 2}>
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label class="sr-only">Password</Form.Label>
				<div
					class={[
						'relative flex w-80 items-center rounded-full bg-white/[0.01] ring-1 ring-white/10',
						$errors.password && 'ring-1 !ring-red-500'
					]}
				>
					<Input
						{...props}
						bind:value={$formData.password}
						type={isVisible ? 'text' : 'password'}
						placeholder="your password"
						autocomplete="new-password"
						class="auth-input rounded-l-full rounded-r-none bg-transparent ring-0 ring-transparent"
					/>
					<button
						type="button"
						onclick={() => (isVisible ? (isVisible = false) : (isVisible = true))}
						class="flex cursor-pointer flex-col items-center pr-3 text-gray transition-colors duration-200 hover:text-foreground"
					>
						{#if isVisible}
							<Eye size={28} strokeWidth={1.1} />
						{:else}
							<EyeOff size={28} strokeWidth={1.1} />
						{/if}
					</button>
				</div>
			{/snippet}
		</Form.Control>
		<Form.Description class="sr-only"
			>This is the email you used to create your account.</Form.Description
		>
		<Form.FieldErrors class="mt-1 ml-6 max-w-80 font-medium text-wrap text-red-500" />
	</Form.Field>

	<Form.Button
		type="submit"
		hidden={pageState.page !== 2}
		disabled={!!$errors.email || !!$errors.name || !!$errors.username || !!$errors.password}
		class="absolute mt-6 w-full cursor-pointer rounded-full bg-transparent py-1.5 font-semibold text-foreground ring-1 ring-white/10 transition-colors duration-150 hover:bg-white/10"
	>
		Create account
	</Form.Button>
</form>
