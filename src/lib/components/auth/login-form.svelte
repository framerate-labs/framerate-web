<script lang="ts">
	import CircleArrowRight from '@lucide/svelte/icons/circle-arrow-right';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { toast } from 'svelte-sonner';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import z4 from 'zod/v4';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	import * as Form from '$components/ui/form/index.js';
	import { Input } from '$components/ui/input/index.js';
	import { authClient } from '$lib/auth-client';
	import { loginSchema } from '$schema/auth-schema';

	const form = superForm(
		{ email: '', password: '' },
		{
			validators: zod4Client(loginSchema),
			onSubmit: ({ formData }) => {
				const data = Object.fromEntries(formData) as z4.infer<typeof loginSchema>;
				if (!data.email || !data.password) {
					toast.error('Please fill all fields correctly.');
					return;
				}
				return handleSubmit(data);
			},
			resetForm: false
		}
	);

	const { form: formData, enhance, errors, validate } = form;

	let isEmailValidated = $state(false);
	let isVisible = $state(false);

	async function validateEmail() {
		if (!isEmailValidated) {
			const errors = await validate('email');
			if (!errors) {
				isEmailValidated = true;
			}
		}
	}

	async function handleSubmit(formData: z4.infer<typeof loginSchema>) {
		const { email, password } = formData;

		await authClient.signIn.email(
			{
				email,
				password
			},
			{
				onRequest: () => {
					toast.loading('Signing in...', { id: 'sign in' });
				},
				onSuccess: async () => {
					toast.dismiss('sign in');
					toast.success('Signed in');
					await goto(resolve('/home'));
				},
				onError: (ctx) => {
					toast.dismiss('sign in');
					const errorCode = ctx.error.code;
					const errorMessage = ctx.error.message;

					switch (errorCode) {
						case 'INVALID_EMAIL_OR_PASSWORD':
							toast.error('Invalid email or password');
							break;
						default:
							toast.error(`An error occurred! ${errorMessage}`, {
								duration: 6000
							});
							console.error(ctx.error);
					}
				}
			}
		);
	}
</script>

<form method="POST" use:enhance>
	<Form.Field {form} name="email">
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
							isEmailValidated ? 'hidden' : 'block'
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
		<Form.FieldErrors class="mt-1 ml-6 max-w-full font-medium text-wrap text-red-500" />
	</Form.Field>

	<!-- Both email and password fields must be in DOM for password managers to autofill -->
	<Form.Field {form} name="password" class={['mt-3', !isEmailValidated && 'hidden']}>
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label class="sr-only">Password</Form.Label>
				<div
					class={[
						'relative flex items-center rounded-full bg-white/[0.01] ring-1 ring-white/10',
						$errors.password && 'ring-1 !ring-red-500'
					]}
				>
					<Input
						{...props}
						bind:value={$formData.password}
						type={isVisible ? 'text' : 'password'}
						placeholder="your password"
						autocomplete="current-password"
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

	{#if isEmailValidated}
		<Form.Button
			type="submit"
			disabled={$errors.email !== undefined || $errors.password !== undefined}
			class="absolute mt-6 w-full cursor-pointer rounded-full bg-transparent py-1.5 font-semibold text-foreground ring-1 ring-white/10 transition-colors duration-150 hover:bg-white/10"
		>
			Login
		</Form.Button>
	{/if}
</form>
