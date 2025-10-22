<script lang="ts">
	import Search from '@lucide/svelte/icons/search';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import CollectionsIcon from '$components/icons/collections-icon.svelte';
	import HomeIcon from '$components/icons/home-icon.svelte';
	import LibraryIcon from '$components/icons/library-icon.svelte';
	import SearchBar from '$components/search/search-bar.svelte';
	import SearchDialog from '$components/search/search-dialog.svelte';
	import SearchResultList from '$components/search/search-result-list.svelte';
	import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '$components/ui/dialog';
	import { TooltipProvider } from '$components/ui/tooltip';

	import Tooltip from './tooltip.svelte';

	// Track which routes should show the navbar
	const pathname = $derived(page.url.pathname);
	const navbarEnabled = $derived.by(() => {
		switch (pathname) {
			case '/':
			case '/login':
			case '/signup':
				return false;
			default:
				return true;
		}
	});

	// False positive with reactivity. Ref does not need to be state.
	// svelte-ignore non_reactive_update
	let searchBtn: HTMLButtonElement | null = null;
	let searchQuery = $state('');

	// Track last pressed key for shortcuts
	let lastKey = '';
	let lastKeyTimeout: number | undefined;
	// ms to wait for second key in sequences
	const SEQUENCE_TIMEOUT = 2500;

	// Keyboard event handler
	function handleKeyDown(e: KeyboardEvent) {
		if (!navbarEnabled) return;

		// Handle slash for search
		if (e.code === 'Slash' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			searchBtn?.click();
			return;
		}

		// Handle 'g' key to start sequence
		if (e.key === 'g' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			lastKey = 'g';
			if (lastKeyTimeout) clearTimeout(lastKeyTimeout);
			lastKeyTimeout = window.setTimeout(() => {
				lastKey = '';
			}, SEQUENCE_TIMEOUT);
			return;
		}

		// Handle second key in sequence
		if (lastKey === 'g' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			lastKey = '';
			if (lastKeyTimeout) clearTimeout(lastKeyTimeout);

			switch (e.key) {
				case 'h':
					goto(resolve('/home'));
					break;
				case 'c':
					goto(resolve('/collections'));
					break;
				case 'l':
					goto(resolve('/library'));
					break;
				// case 'm':
				// 	goto(resolve('/profile'));
				// 	break;
				// case 'p':
				// 	goto(resolve('/preferences'));
				// 	break;
			}
		}
	}

	// Set up and clean up keyboard listeners
	$effect(() => {
		if (typeof window === 'undefined') return;

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			if (lastKeyTimeout) clearTimeout(lastKeyTimeout);
		};
	});

	// Define navigation tabs
	const tabs = [
		{
			id: 1,
			name: 'Home',
			href: '/home' as const,
			key1: 'G',
			key2: 'H',
			icon: HomeIcon
		},
		{
			id: 3,
			name: 'Collections',
			href: '/collections' as const,
			key1: 'G',
			key2: 'C',
			icon: CollectionsIcon
		},
		{
			id: 4,
			name: 'Library',
			href: '/library' as const,
			key1: 'G',
			key2: 'L',
			icon: LibraryIcon
		}
	];

	function isActive(href: string) {
		return pathname === href || (href !== '/home' && pathname.startsWith(href + '/'));
	}
</script>

{#if navbarEnabled}
	<TooltipProvider delayDuration={600}>
		<div
			class="fixed right-0 bottom-2 left-0 z-50 mx-auto flex w-fit items-center justify-center gap-x-2"
		>
			<div
				class="rounded-full border border-white/10 bg-background-dark/70 shadow-md backdrop-blur-sm"
			>
				<nav class="relative flex gap-x-6 px-6 py-0">
					{#each tabs as tab (tab.id)}
						{@const Component = tab.icon}
						<Tooltip side="top" sideOffset={14} content={tab.name} key1={tab.key1} key2={tab.key2}>
							<a
								href={resolve(tab.href)}
								class={[
									isActive(tab.href) ? 'text-[#522aff]' : 'text-neutral-200',
									'relative flex items-center justify-center bg-transparent transition-all duration-200 ease-in-out before:absolute before:top-0 before:bottom-0 before:my-auto before:size-8 before:rounded-full before:transition-all before:duration-200 before:ease-in-out hover:text-[#522aff] focus:outline-[#522aff]'
								]}
							>
								<Component />
							</a>
						</Tooltip>
					{/each}
				</nav>
			</div>

			<!-- Search dialog -->
			<Dialog>
				<Tooltip side="top" sideOffset={14} content="Search" key1="/">
					<DialogTrigger
						bind:ref={searchBtn}
						class="relative text-neutral-200 outline-0 transition-colors duration-200 ease-in-out hover:text-[#522aff]"
					>
						{#snippet child({ props })}
							<div
								{...props}
								class="flex size-12 items-center justify-center rounded-full border border-white/10 bg-background-dark/70 shadow-md backdrop-blur-sm"
							>
								<Search width={24} height={48} strokeWidth={1.5} class="relative" />
							</div>
						{/snippet}
					</DialogTrigger>
				</Tooltip>

				<SearchDialog>
					<DialogTitle class="sr-only">Search</DialogTitle>
					<DialogDescription class="sr-only">
						Search for a movie or tv series by name.
					</DialogDescription>

					<SearchBar bind:searchQuery />
					<SearchResultList query={searchQuery} />
				</SearchDialog>
			</Dialog>
		</div>
	</TooltipProvider>
{/if}
