<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Fingerprint from '@lucide/svelte/icons/fingerprint';
	import Ticket from '@lucide/svelte/icons/ticket';
	import { toast } from 'svelte-sonner';

	import { resolve } from '$app/paths';

	import { apiBaseUrl } from '$lib/services/client-instance';

	let isLoggingIn = $state(false);

	async function handleDemoLogin() {
		isLoggingIn = true;
		try {
			toast.loading('Signing in...', { id: 'sign in' });
			const response = await fetch(`${apiBaseUrl}/api/v1/demo/login`, {
				method: 'POST',
				credentials: 'include'
			});

			if (!response.ok) {
				const error = await response.json();
				console.error('Demo login error:', error);
				toast.error('Demo account not available. Please try again later.');
				return;
			}

			// Force reload to activate the new session
			window.location.href = '/home';
		} catch (error) {
			console.error('Demo login failed:', error);
			toast.error('Failed to login to demo account');
		} finally {
			isLoggingIn = false;
			toast.dismiss('sign in');
		}
	}
</script>

<div class="relative min-h-screen">
	<header>
		<nav class="flex items-center justify-between md:pt-12">
			<a href={resolve('/')}>
				<h1 class="text-lg font-extrabold md:text-3xl">FrameRate</h1>
			</a>

			<div class="flex items-center gap-4 text-sm font-semibold md:gap-10 md:text-base">
				<a href={resolve('/login')} class="group/login flex items-center gap-1.5 md:gap-2">
					<span class="text-gray transition-colors duration-200 group-hover/login:text-foreground">
						<Fingerprint size={18} />
					</span>
					Login
				</a>

				<a href={resolve('/signup')} class="group/signup peer flex items-center gap-1.5 md:gap-2">
					<span class="text-gray transition-colors duration-200 group-hover/signup:text-foreground">
						<Ticket size={18} />
					</span>
					Create free account
				</a>
			</div>
		</nav>
	</header>

	<div class="mx-auto">
		<!-- Image -->
		<section class="relative mx-auto w-[95%]">
			<div class="mx-auto mt-10 md:mt-14">
				<img
					src="https://image.tmdb.org/t/p/original/5syRZHBCzzCwkluq7EMrE8vYdlE.jpg"
					alt="Julia Garner in Weapons (2025)."
					width={1920}
					height={1080}
					decoding="async"
					loading="eager"
					class="aspect-143/100 animate-fade-in rounded-3xl rounded-br-none rounded-bl-none object-cover"
				/>
				<div class="easing-gradient absolute top-0 right-0 left-0 size-full"></div>
				<span
					class="absolute top-1/2 -right-2 z-10 -rotate-90 text-[0.625rem] font-medium tracking-wide text-nowrap text-foreground/70 md:text-sm md:tracking-normal"
				>
					Weapons (2025)
				</span>
			</div>

			<!-- Hero Text -->
			<section class="absolute top-11/12 right-0 left-0 z-50 mx-auto w-fit text-center md:top-3/5">
				<div class="mb-4 md:mb-6">
					<h2 class="text-[1.375rem] font-bold md:text-4xl md:tracking-tight">
						From premieres to finales.
					</h2>
					<p class="mt-1 text-sm font-semibold md:mt-2 md:text-[1.125rem] md:tracking-wide">
						Every movie. Every show. Every moment.
					</p>
				</div>

				<!-- CTA -->
				<div class="flex flex-col items-center gap-3">
					<a href={resolve('/signup')} class="inline-block">
						<div
							class="rounded-full border border-indigo-700 bg-indigo-800/20 px-14 py-2 shadow-md inset-shadow-xs inset-shadow-indigo-600 transition-colors duration-150 ease-in-out hover:bg-indigo-700"
						>
							<span class="font-semibold tracking-wide text-foreground"> Start Tracking </span>
						</div>
					</a>

					<button
						onclick={handleDemoLogin}
						disabled={isLoggingIn}
						class="flex items-end gap-1 text-[1.0625rem] font-semibold transition-colors duration-200 disabled:opacity-60"
					>
						Or try the <span class="group flex cursor-pointer items-end gap-1 font-bold"
							>Demo <ArrowRight
								strokeWidth={2}
								size={20}
								class="mb-[1.5px] cursor-pointer duration-200 group-hover:translate-x-0.5 hover:translate-x-0.5"
							/></span
						>
					</button>
				</div>
			</section>
		</section>
	</div>
</div>
