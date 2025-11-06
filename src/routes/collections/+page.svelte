<script lang="ts">
	import type { PageData } from './$types';

	import { createQuery } from '@tanstack/svelte-query';
	import { getLists } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import { resolve } from '$app/paths';

	import PopularListsGrid from '$components/lists/popular-lists-grid.svelte';
	import SidebarSkeleton from '$components/lists/sidebar-skeleton.svelte';
	import Sidebar from '$components/lists/sidebar.svelte';
	import Header from '$components/shared/header.svelte';
	import * as Drawer from '$components/ui/drawer/index';
	import { userStore } from '$stores/user-store.svelte';

	let { data }: { data: PageData } = $props();

	const listsQuery = createQuery(() => ({
		queryKey: ['lists'],
		queryFn: getLists,
		staleTime: 10 * 60 * 1000,
		gcTime: 20 * 60 * 1000,
		retry: 2
	}));

	const username = userStore.username;

	$effect(() => {
		if (username && listsQuery.error) {
			toast.error('Failed to load your collections');
		}
	});
</script>

<div class="size-full">
	<Header title="Collections" />
	<!-- Mobile drawer trigger for sidebar -->
	<div class="mb-3 md:hidden">
		<Drawer.Root>
			<Drawer.Trigger>
				{#snippet child({ ...props })}
					<button
						class="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium hover:bg-white/10"
					>
						View Your Collections
					</button>
				{/snippet}
			</Drawer.Trigger>
			<Drawer.Content>
				<Drawer.Header class="sr-only">
					<Drawer.Title>Your Collections</Drawer.Title>
					<Drawer.Description>Navigate and manage your lists</Drawer.Description>
				</Drawer.Header>
				<div class="overflow-y-auto p-4 pb-4 md:py-0">
					{#if listsQuery.isFetching}
						<SidebarSkeleton />
					{/if}

					{#if listsQuery.isFetched && !listsQuery.data}
						<div
							class="mx-auto mt-2 max-w-lg rounded-md border border-white/10 bg-background-dark p-6 text-center"
						>
							<p class="mb-4 text-base font-medium">Please log in to view your collections.</p>
							<a
								href={resolve('/login')}
								class="inline-block rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10"
							>
								Go to Login
							</a>
						</div>
					{/if}

					{#if listsQuery.data}
						<Sidebar formData={data} />
					{/if}
				</div>
			</Drawer.Content>
		</Drawer.Root>
	</div>

	<main class="flex h-[calc(100vh-var(--header-height))] animate-fade-in gap-2.5 pb-6">
		<section
			class="hidden w-[150px] shrink-0 flex-col md:flex md:w-[200px] md:min-w-[200px] lg:w-60"
		>
			{#if listsQuery.isFetching}
				<SidebarSkeleton />
			{/if}

			{#if listsQuery.isFetched && !listsQuery.data}
				<div
					class="mx-auto mt-2 w-full rounded-md border border-white/10 bg-background-dark p-4 text-center"
				>
					<p class="mb-3 text-sm font-medium">Please log in to view your collections.</p>
					<a
						href={resolve('/login')}
						class="inline-block rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/10"
					>
						Go to Login
					</a>
				</div>
			{/if}

			{#if listsQuery.data}
				<Sidebar formData={data} />
			{/if}
		</section>

		<section class="scrollbar-hide mx-auto grow overflow-y-auto pr-1">
			<PopularListsGrid />
		</section>
	</main>
</div>
