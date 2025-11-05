<script lang="ts">
	import type { ListData } from '$types/lists';
	import type { RouteParams } from '../../../routes/[username]/collections/[slug]/edit/$types';

	import { useQueryClient } from '@tanstack/svelte-query';
	import { addListAction, deleteListAction } from '$services/actions';
	import { deleteList } from '$services/lists';
	import { toast } from 'svelte-sonner';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import MediaActionIcon from '$components/icons/media-actions-icons.svelte';
	import * as Dialog from '$components/ui/dialog/index';
	import { authClient } from '$lib/auth-client';

	interface Props {
		listData: ListData;
	}

	let { listData }: Props = $props();

	const { username, slug } = page.params as RouteParams;

	const queryClient = useQueryClient();

	const activeUser = authClient.useSession();

	const formatter = Intl.NumberFormat('en', { notation: 'compact' });

	let list = $derived(listData?.list);
	let likeCount = $derived(listData?.list.likeCount ?? 0);
	let saveCount = $derived(listData?.list.saveCount ?? 0);
	let isLiked = $derived(listData?.isLiked ?? false);
	let isSaved = $derived(listData?.isSaved ?? false);
	let activeUserId = $derived($activeUser.data?.user.id);
	let isListOwner = $derived(list?.userId === activeUserId);

	async function updateListAction(
		actionType: 'like' | 'save',
		currentState: boolean,
		currentCount: number
	) {
		if (!listData || !list) return;

		const countKey = actionType === 'like' ? 'likeCount' : 'saveCount';
		const stateKey = actionType === 'like' ? 'isLiked' : 'isSaved';

		// Optimistic cache update
		queryClient.setQueryData(['list-items', username, slug], (old: ListData | undefined) => {
			if (!old) return old;
			return {
				...old,
				list: {
					...old.list,
					[countKey]: currentState ? old.list[countKey] - 1 : old.list[countKey] + 1
				},
				[stateKey]: !currentState
			};
		});

		try {
			if (currentState) {
				await deleteListAction(list.id, actionType);
			} else {
				await addListAction(list.id, actionType);
			}
		} catch {
			// Rollback on error
			queryClient.setQueryData(['list-items', username, slug], (old: ListData | undefined) => {
				if (!old) return old;
				return {
					...old,
					list: { ...old.list, [countKey]: currentCount },
					[stateKey]: currentState
				};
			});
			toast.error(`Failed to update ${actionType}! Please try again later`);
		}
	}

	async function updateLike() {
		await updateListAction('like', isLiked, likeCount);
	}

	async function updateSave() {
		await updateListAction('save', isSaved, saveCount);
	}

	async function handleDelete() {
		if (!list) return;

		try {
			const deleted = await deleteList(list.id);
			if (deleted) toast.success('List deleted');
			queryClient.invalidateQueries({ queryKey: ['lists'] });
			goto(resolve('/collections'));
		} catch {
			toast.error('Failed to delete list! Please try again later');
		}
	}
</script>

{#if listData && listData.listItems?.length > 0}
	<aside
		class="relative order-1 flex w-full flex-col items-center self-start rounded-md border border-white/5 bg-background p-3 shadow-md md:order-2 md:w-auto md:p-4 lg:p-6"
	>
		{#if isListOwner}
			<div class="mb-6 flex gap-3">
				<a
					href={resolve('/[username]/collections/[slug]/edit', { username, slug })}
					class="transiton-colors ease rounded-md border border-white/5 bg-[#28292d] px-4 py-2 font-medium duration-150 hover:border-white/10 hover:bg-transparent"
				>
					Edit
				</a>

				<Dialog.Root>
					<Dialog.Trigger>
						{#snippet child({ ...props })}
							<button
								class="ease cursor-pointer rounded-md border border-white/5 bg-[#28292d] px-4 py-2 font-medium transition-colors duration-150 hover:border-red-500 hover:bg-transparent"
							>
								Delete
							</button>
						{/snippet}
					</Dialog.Trigger>

					<Dialog.Content>
						<Dialog.Header>
							<Dialog.Title>Delete this list?</Dialog.Title>
							<Dialog.Description
								>This action cannot be undone. This will permanently delete your list and its
								content, including metadata such as likes, saves, and views.</Dialog.Description
							>
						</Dialog.Header>

						<Dialog.Footer>
							<Dialog.Close>
								<button
									class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-background-light bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-light hover:text-foreground"
								>
									Cancel
								</button>
							</Dialog.Close>
							<Dialog.Close>
								<button
									onclick={handleDelete}
									class="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border-red-800 bg-red-700 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-red-800"
								>
									Delete
								</button>
							</Dialog.Close>
						</Dialog.Footer>
					</Dialog.Content>
				</Dialog.Root>
			</div>
		{/if}

		<div class="flex w-full items-center justify-center gap-10 text-[#555] md:gap-6">
			<div class="flex items-center justify-center gap-2">
				<MediaActionIcon
					component="heart"
					fill="#333"
					onclick={() => updateLike()}
					classes={[
						isLiked ? 'fill-[#FF153A]' : '',
						'hover:fill-[#FF153A] cursor-pointer ease transition-all duration-150 active:scale-90 h-6'
					]}
				/>
				<p class="cursor-default">{formatter.format(likeCount)}</p>
			</div>

			<div class="flex items-center justify-center gap-2">
				<MediaActionIcon
					component="bookmark"
					fill="#333"
					onclick={() => updateSave()}
					classes={[
						isSaved ? 'fill-[#32EC44]' : '',
						'hover:fill-[#32EC44] cursor-pointer ease transition-all duration-150 active:scale-90 h-6'
					]}
				/>
				<p class="cursor-default">{formatter.format(saveCount)}</p>
			</div>
		</div>
	</aside>
{/if}
