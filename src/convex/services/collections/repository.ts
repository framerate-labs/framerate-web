import type { Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

import {
	assertRestrictionsAllowMedia,
	computePopularityScore,
	MAX_COLLECTION_ITEMS,
	ORDER_STEP
} from '../../utils/collections/core';
import { sortItemsForCollectionPreview } from '../../utils/collections/sorting';
import type {
	CollectionCollaboratorDoc,
	CollectionDoc,
	CollectionItemDoc,
	CollectionMediaKey,
	CollectionViewerInviteDoc,
	Restrictions,
	UserProfileDoc
} from '../../types/collectionTypes';

const COLLECTION_COVER_PREVIEW_LIMIT = 3;

export async function getProfileByUserId(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<UserProfileDoc | null> {
	return await ctx.db
		.query('userProfiles')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.unique();
}

export async function getProfilesByUserIds(
	ctx: QueryCtx | MutationCtx,
	userIds: string[]
): Promise<Map<string, UserProfileDoc | null>> {
	const deduped = Array.from(new Set(userIds));
	const rows = await Promise.all(
		deduped.map(async (userId) => [userId, await getProfileByUserId(ctx, userId)] as const)
	);
	return new Map(rows);
}

export async function getCollaboratorRow(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	userId: string
): Promise<CollectionCollaboratorDoc | null> {
	return await ctx.db
		.query('collectionCollaborators')
		.withIndex('by_collectionId_userId', (q) =>
			q.eq('collectionId', collectionId).eq('userId', userId)
		)
		.unique();
}

export async function getViewerInviteRow(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	userId: string
): Promise<CollectionViewerInviteDoc | null> {
	return await ctx.db
		.query('collectionViewerInvites')
		.withIndex('by_collectionId_userId', (q) =>
			q.eq('collectionId', collectionId).eq('userId', userId)
		)
		.unique();
}

export async function getFollowRow(
	ctx: QueryCtx | MutationCtx,
	followerUserId: string,
	followedUserId: string
) {
	return await ctx.db
		.query('socialFollows')
		.withIndex('by_follower_followed', (q) =>
			q.eq('followerUserId', followerUserId).eq('followedUserId', followedUserId)
		)
		.unique();
}

export async function loadCollectionItems(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>
) {
	return await ctx.db
		.query('collectionItems')
		.withIndex('by_collectionId_sortOrder', (q) => q.eq('collectionId', collectionId))
		.collect();
}

export async function hasReachedCollectionItemLimit(
	ctx: QueryCtx | MutationCtx,
	collection: Pick<CollectionDoc, '_id' | 'itemCount'>
) {
	if (collection.itemCount < MAX_COLLECTION_ITEMS - 1) {
		return false;
	}

	const itemsAtLimit = await ctx.db
		.query('collectionItems')
		.withIndex('by_collectionId_sortOrder', (q) => q.eq('collectionId', collection._id))
		.take(MAX_COLLECTION_ITEMS);
	return itemsAtLimit.length >= MAX_COLLECTION_ITEMS;
}

export async function loadCollectionItemsForTier(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	tierKey: string | null
) {
	return await ctx.db
		.query('collectionItems')
		.withIndex('by_collectionId_tierKey_sortOrder', (q) =>
			q.eq('collectionId', collectionId).eq('tierKey', tierKey)
		)
		.collect();
}

export async function loadCollectionTiers(ctx: QueryCtx | MutationCtx, collectionId: Id<'collections'>) {
	return await ctx.db
		.query('collectionTiers')
		.withIndex('by_collectionId_sortOrder', (q) => q.eq('collectionId', collectionId))
		.collect();
}

export async function assertCreatorOnlyHasNoSharing(
	ctx: MutationCtx,
	collectionId: Id<'collections'>
) {
	const [collaborators, viewerInvites] = await Promise.all([
		ctx.db
			.query('collectionCollaborators')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
			.take(1),
		ctx.db
			.query('collectionViewerInvites')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
			.take(1)
	]);
	if (collaborators.length > 0 || viewerInvites.length > 0) {
		throw new Error(
			'Remove collaborators and view-only shares before switching this collection to creator-only.'
		);
	}
}

export async function assertExistingItemsRespectRestrictions(
	ctx: MutationCtx,
	collectionId: Id<'collections'>,
	restrictions: Restrictions
) {
	const items = await loadCollectionItems(ctx, collectionId);
	for (const item of items) {
		assertRestrictionsAllowMedia(restrictions, {
			mediaType: item.mediaType,
			isAnime: item.isAnime
		});
	}
}

export async function rebalanceCollectionItems(
	ctx: MutationCtx,
	collectionId: Id<'collections'>,
	tierKey: string | null
) {
	const items =
		tierKey == null
			? await loadCollectionItemsForTier(ctx, collectionId, null)
			: await loadCollectionItemsForTier(ctx, collectionId, tierKey);
	for (const [index, item] of items
		.sort((left, right) => left.sortOrder - right.sortOrder)
		.entries()) {
		await ctx.db.patch(item._id, {
			sortOrder: (index + 1) * ORDER_STEP,
			updatedAt: Date.now()
		});
	}
}

export async function refreshCollectionCoverAndCounts(ctx: MutationCtx, collection: CollectionDoc) {
	const tiers =
		collection.layout === 'tiered' ? await loadCollectionTiers(ctx, collection._id) : [];
	const items = sortItemsForCollectionPreview(
		await loadCollectionItems(ctx, collection._id),
		collection,
		tiers
	);
	const coverItems = items.slice(0, COLLECTION_COVER_PREVIEW_LIMIT).map((item) => ({
		mediaType: item.mediaType,
		tmdbId: item.tmdbId ?? null,
		title: item.title,
		posterPath: item.posterPath ?? null,
		isAnime: item.isAnime
	}));
	await ctx.db.patch(collection._id, {
		coverItems,
		itemCount: items.length
	});
}

export async function patchCollectionMetrics(
	ctx: MutationCtx,
	collection: CollectionDoc,
	updates: Partial<
		Pick<
			CollectionDoc,
			| 'likeCount'
			| 'saveCount'
			| 'commentCount'
			| 'viewCount'
			| 'lastCommentAt'
			| 'lastViewedAt'
			| 'activityAt'
		>
	>
) {
	const next = {
		likeCount: updates.likeCount ?? collection.likeCount,
		saveCount: updates.saveCount ?? collection.saveCount,
		commentCount: updates.commentCount ?? collection.commentCount,
		viewCount: updates.viewCount ?? collection.viewCount,
		lastCommentAt: updates.lastCommentAt ?? collection.lastCommentAt,
		lastViewedAt: updates.lastViewedAt ?? collection.lastViewedAt,
		activityAt: updates.activityAt ?? collection.activityAt
	};
	await ctx.db.patch(collection._id, {
		...next,
		popularityScore: computePopularityScore(next)
	});
}

export async function createDefaultTiers(
	ctx: MutationCtx,
	collectionId: Id<'collections'>,
	now: number,
	tiers: Array<{ key: string; label: string }>
) {
	for (const [index, tier] of tiers.entries()) {
		await ctx.db.insert('collectionTiers', {
			collectionId,
			key: tier.key,
			label: tier.label,
			sortOrder: (index + 1) * ORDER_STEP,
			createdAt: now,
			updatedAt: now
		});
	}
}

export async function resolveCollectionMediaKey(
	ctx: QueryCtx,
	args: { mediaType: 'movie' | 'tv'; tmdbId: number }
): Promise<CollectionMediaKey | null> {
	if (args.mediaType === 'movie') {
		const movie = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
			.unique();
		return movie ? { mediaType: 'movie', movieId: movie._id } : null;
	}

	const tvShow = await ctx.db
		.query('tvShows')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
		.unique();
	return tvShow ? { mediaType: 'tv', tvShowId: tvShow._id } : null;
}

export async function getCollectionItemByMediaKey(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	mediaKey: CollectionMediaKey
): Promise<CollectionItemDoc | null> {
	if (mediaKey.mediaType === 'movie') {
		return await ctx.db
			.query('collectionItems')
			.withIndex('by_collectionId_movieId', (q) =>
				q.eq('collectionId', collectionId).eq('movieId', mediaKey.movieId)
			)
			.unique();
	}

	return await ctx.db
		.query('collectionItems')
		.withIndex('by_collectionId_tvShowId', (q) =>
			q.eq('collectionId', collectionId).eq('tvShowId', mediaKey.tvShowId)
		)
		.unique();
}

export async function deleteCollectionRecords(ctx: MutationCtx, collectionId: Id<'collections'>) {
	const [collaborators, viewerInvites, items, tiers, comments, likes, saves, views] =
		await Promise.all([
			ctx.db
				.query('collectionCollaborators')
				.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
				.collect(),
			ctx.db
				.query('collectionViewerInvites')
				.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
				.collect(),
			loadCollectionItems(ctx, collectionId),
			loadCollectionTiers(ctx, collectionId),
			ctx.db
				.query('collectionComments')
				.withIndex('by_collectionId_createdAt', (q) => q.eq('collectionId', collectionId))
				.collect(),
			ctx.db
				.query('collectionLikes')
				.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
				.collect(),
			ctx.db
				.query('collectionSaves')
				.withIndex('by_collectionId', (q) => q.eq('collectionId', collectionId))
				.collect(),
			ctx.db
				.query('collectionViews')
				.withIndex('by_collectionId_windowStart', (q) => q.eq('collectionId', collectionId))
				.collect()
		]);

	for (const rows of [collaborators, viewerInvites, items, tiers, comments, likes, saves, views]) {
		for (const row of rows) {
			await ctx.db.delete(row._id);
		}
	}
}
