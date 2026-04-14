import type { QueryCtx } from '../../_generated/server';
import { MAX_VISIBLE_COMMENTS, normalizeShareAudience } from '../../utils/collections/core';
import {
	resolvedCollectionSortDirection,
	sortItemsForPresentation
} from '../../utils/collections/sorting';
import type {
	CollectionDoc,
	UserProfileDoc,
	ViewerRole
} from '../../types/collectionTypes';
import {
	canChangeVisibility,
	canCloneCollection,
	canEditCollection,
	canInviteCollaborators,
	canSaveCollection,
	canToggleComments
} from './access';
import {
	getProfilesByUserIds,
	getProfileByUserId,
	loadCollectionItems,
	loadCollectionTiers
} from './repository';

export function presentProfile(profile: UserProfileDoc | null, userId: string) {
	return {
		userId,
		displayName: profile?.displayName ?? 'Unknown User',
		username: profile?.username ?? null,
		email: profile?.email ?? null,
		profilePictureUrl: profile?.profilePictureUrl ?? null
	};
}

export async function presentCollectionSummary(
	ctx: QueryCtx,
	collection: CollectionDoc,
	userId: string | null,
	role: ViewerRole,
	options?: {
		creatorProfile?: UserProfileDoc | null;
		isLiked?: boolean;
		isSaved?: boolean;
	}
) {
	const creatorProfile =
		options && 'creatorProfile' in options
			? options.creatorProfile ?? null
			: await getProfileByUserId(ctx, collection.creatorId);
	let isLiked = options?.isLiked ?? false;
	let isSaved = options?.isSaved ?? false;
	if (userId && (options?.isLiked === undefined || options?.isSaved === undefined)) {
		const [likeRow, saveRow] = await Promise.all([
			ctx.db
				.query('collectionLikes')
				.withIndex('by_collectionId_userId', (q) =>
					q.eq('collectionId', collection._id).eq('userId', userId)
				)
				.unique(),
			ctx.db
				.query('collectionSaves')
				.withIndex('by_collectionId_userId', (q) =>
					q.eq('collectionId', collection._id).eq('userId', userId)
				)
				.unique()
		]);
		if (options?.isLiked === undefined) {
			isLiked = likeRow !== null;
		}
		if (options?.isSaved === undefined) {
			isSaved = saveRow !== null;
		}
	}
	return {
		id: collection._id,
		shareKey: collection.shareKey,
		slug: collection.slug,
		title: collection.title,
		description: collection.description,
		visibility: collection.visibility,
		shareAudience: normalizeShareAudience(collection.visibility, collection.shareAudience),
		layout: collection.layout,
		commentsEnabled: collection.commentsEnabled,
		restrictions: collection.restrictions,
		defaultSort: collection.defaultSort,
		defaultSortDirection: resolvedCollectionSortDirection(collection),
		creator: presentProfile(creatorProfile, collection.creatorId),
		role,
		collaboratorCount: collection.collaboratorCount,
		itemCount: collection.itemCount,
		likeCount: collection.likeCount,
		saveCount: collection.saveCount,
		commentCount: collection.commentCount,
		viewCount: collection.viewCount,
		coverItems: collection.coverItems,
		createdAt: collection.createdAt,
		updatedAt: collection.updatedAt,
		lastCommentAt: collection.lastCommentAt,
		lastViewedAt: collection.lastViewedAt,
		activityAt: collection.activityAt,
		isLiked,
		isSaved,
		canEdit: canEditCollection(role),
		canChangeVisibility: canChangeVisibility(role),
		canToggleComments: canToggleComments(role),
		canInviteCollaborators: canInviteCollaborators(role),
		canSave: canSaveCollection(collection, role),
		canClone: canCloneCollection(collection, role)
	};
}

export async function buildMyCollectionSummaries(
	ctx: QueryCtx,
	userId: string,
	collectionEntries: Array<{ collection: CollectionDoc; role: ViewerRole }>
) {
	const creatorProfiles = await getProfilesByUserIds(
		ctx,
		collectionEntries.map(({ collection }) => collection.creatorId)
	);
	return await Promise.all(
		collectionEntries.map(async ({ collection, role }) =>
			presentCollectionSummary(ctx, collection, userId, role, {
				creatorProfile: creatorProfiles.get(collection.creatorId) ?? null
			})
		)
	);
}

export async function buildCollectionDetailPayload(
	ctx: QueryCtx,
	collection: CollectionDoc,
	role: ViewerRole,
	userId: string | null
) {
	const [collaborators, viewerInvites, items, tiers, comments] = await Promise.all([
		ctx.db
			.query('collectionCollaborators')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collection._id))
			.collect(),
		ctx.db
			.query('collectionViewerInvites')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collection._id))
			.collect(),
		loadCollectionItems(ctx, collection._id),
		collection.layout === 'tiered'
			? loadCollectionTiers(ctx, collection._id)
			: Promise.resolve([]),
		ctx.db
			.query('collectionComments')
			.withIndex('by_collectionId_createdAt', (q) => q.eq('collectionId', collection._id))
			.order('desc')
			.take(MAX_VISIBLE_COMMENTS)
	]);
	const profileIds = [
		collection.creatorId,
		...collaborators.map((row) => row.userId),
		...viewerInvites.map((row) => row.userId),
		...comments.map((comment) => comment.userId)
	];
	const profiles = await getProfilesByUserIds(ctx, profileIds);
	const viewerInviteForUser =
		userId === null ? null : viewerInvites.find((row) => row.userId === userId) ?? null;
	const presented = await presentCollectionSummary(ctx, collection, userId, role, {
		creatorProfile: profiles.get(collection.creatorId) ?? null
	});
	const presentedItems = sortItemsForPresentation(items, collection.layout, tiers);
	const canLeave = userId !== null && (role === 'collaborator' || viewerInviteForUser !== null);
	return {
		...presented,
		canLeave,
		collaborators: collaborators.map((row) =>
			presentProfile(profiles.get(row.userId) ?? null, row.userId)
		),
		viewerInvites: viewerInvites.map((row) =>
			presentProfile(profiles.get(row.userId) ?? null, row.userId)
		),
		items: presentedItems.items,
		tiers: presentedItems.tiers,
		comments: comments.map((comment) => ({
			id: comment._id,
			body: comment.body,
			createdAt: comment.createdAt,
			updatedAt: comment.updatedAt,
			author: presentProfile(profiles.get(comment.userId) ?? null, comment.userId),
			canDelete: userId === comment.userId || role === 'creator' || role === 'collaborator'
		}))
	};
}
