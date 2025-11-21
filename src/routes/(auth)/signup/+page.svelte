<script lang="ts">
	import CircleArrowLeft from '@lucide/svelte/icons/circle-arrow-left';
	import X from '@lucide/svelte/icons/x';

	import { resolve } from '$app/paths';

	import AuthContent from '$components/auth/auth-content.svelte';
	import AuthFooter from '$components/auth/auth-footer.svelte';
	import RotatingQuotes from '$components/auth/rotating-quotes.svelte';
	import SignupForm from '$components/auth/signup-form.svelte';

	let pageState = $state({ page: 1 });
	let reduceMotion = $state(false);

	$effect(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reduceMotion = mq.matches;
		const handler = (e: MediaQueryListEvent) => (reduceMotion = e.matches);
		mq.addEventListener?.('change', handler);

		return () => mq.removeEventListener?.('change', handler);
	});

	function handleClick() {
		pageState.page = 1;
	}
</script>

<svelte:head>
	<title>Sign Up - FrameRate</title>
	<meta
		name="description"
		content="Create a FrameRate account to start rating, reviewing, and building your personal library of movies and TV series."
	/>
</svelte:head>

{#if !reduceMotion}
	<div
		aria-hidden={true}
		class="signup-animated-mesh absolute top-24 right-0 bottom-0 left-0 m-auto h-1/2 w-1/2"
	></div>
{/if}

<div
	aria-hidden={true}
	class="pointer-events-none fixed inset-0 z-0 bg-black/70 backdrop-blur-3xl"
></div>

<div class="relative flex w-full flex-1 flex-col items-center justify-center">
	<a
		href={resolve('/')}
		aria-label="Close and go to home"
		class="absolute top-2 left-2 rounded-full bg-white/[0.03] p-1 text-foreground transition-colors duration-200 hover:bg-white/5 md:top-8"
	>
		<X size={18} />
	</a>

	<div class={`mb-3 h-12 ${pageState.page === 2 ? 'block' : 'hidden'}`}>
		<RotatingQuotes />
	</div>

	<div class="relative animate-fade-in">
		{#if pageState.page === 1}
			<AuthContent
				title="Welcome to FrameRate"
				description="Thank you for being an early adopter. Let's set up your account."
			/>
		{/if}

		<section>
			{#if pageState.page === 2}
				<button
					type="button"
					onclick={handleClick}
					class="mb-7 w-fit text-gray transition-colors duration-200 hover:text-foreground"
				>
					<CircleArrowLeft size={32} strokeWidth={1.1} />
				</button>
			{/if}
			<SignupForm {pageState} />
		</section>
	</div>
</div>

<AuthFooter text="Already have an account?" linkText="Login" linkTo="/login" />
