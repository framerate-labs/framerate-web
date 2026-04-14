import type { CollectionDoc, CollectionTierDoc } from './types/collectionTypes';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import {
	buildMyCollectionDocuments,
	buildMyCollectionEntries,
	canChangeVisibility,
	canCloneCollection,
	canInviteCollaborators,
	canRemoveCollaborator,
	canSaveCollection,
	canToggleComments,
	canViewCollection,
	getViewerRole,
	requireCollectionAccess,
	requireIdentity
} from './services/collections/access';
import { loadCanonicalMediaForCollectionItem } from './services/collections/media';
import {
	buildCollectionDetailPayload,
	buildMyCollectionSummaries,
	presentCollectionSummary
} from './services/collections/presentation';
import {
	assertCreatorOnlyHasNoSharing,
	assertExistingItemsRespectRestrictions,
	createDefaultTiers,
	deleteCollectionRecords,
	getCollaboratorRow,
	getCollectionItemByMediaKey,
	getProfileByUserId,
	getProfilesByUserIds,
	getViewerInviteRow,
	hasReachedCollectionItemLimit,
	loadCollectionItems,
	loadCollectionItemsForTier,
	loadCollectionTiers,
	patchCollectionMetrics,
	rebalanceCollectionItems,
	refreshCollectionCoverAndCounts,
	resolveCollectionMediaKey
} from './services/collections/repository';
import {
	assertRestrictionsAllowMedia,
	collectionItemLimitErrorMessage,
	computeSortOrderBetween,
	defaultRestrictions,
	defaultTierDefinitions,
	isCreatorOnlyPrivateCollection,
	makeShareKey,
	MAX_COLLABORATORS,
	MAX_COLLECTION_ITEMS,
	MAX_VIEWER_INVITES,
	maybeNeedsRebalance,
	normalizeCommentBody,
	normalizeDescription,
	normalizeShareAudience,
	normalizeTitle,
	ORDER_STEP,
	sanitizeTierInputs,
	slugifyTitle,
	validateRestrictions,
	VIEW_RETENTION_MS,
	VIEW_WINDOW_MS
} from './utils/collections/core';
import { resolvedCollectionSortDirection } from './utils/collections/sorting';

const visibilityValidator = v.union(v.literal('private'), v.literal('public'));
const shareAudienceValidator = v.union(
	v.literal('creatorOnly'),
	v.literal('anyone'),
	v.literal('friends'),
	v.literal('followers')
);
const layoutValidator = v.union(v.literal('ordered'), v.literal('unordered'), v.literal('tiered'));
const sortOptionValidator = v.union(
	v.literal('custom'),
	v.literal('title'),
	v.literal('releaseDate'),
	v.literal('dateAdded')
);
const sortDirectionValidator = v.union(v.literal('ascending'), v.literal('descending'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const restrictionsValidator = v.object({
	allowMovies: v.boolean(),
	allowTV: v.boolean(),
	allowAnime: v.boolean(),
	allowNonAnime: v.boolean()
});
const tierInputValidator = v.object({
	key: v.string(),
	label: v.string()
});
const addItemInputValidator = v.object({
	mediaType: mediaTypeValidator,
	source: sourceValidator,
	externalId: v.union(v.number(), v.string()),
	title: v.string(),
	posterPath: v.optional(v.union(v.string(), v.null()))
});

export const getMyCollections = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		const collectionEntries = await buildMyCollectionEntries(ctx, identity.subject);
		return await buildMyCollectionSummaries(ctx, identity.subject, collectionEntries);
	}
});

export const getPopularPublicCollections = query({
	args: {
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
		const collections = await ctx.db
			.query('collections')
			.withIndex('by_visibility_popularityScore', (q) => q.eq('visibility', 'public'))
			.order('desc')
			.take(limit);
		const creatorProfiles = await getProfilesByUserIds(
			ctx,
			collections.map((collection) => collection.creatorId)
		);
		return await Promise.all(
			collections.map(async (collection) =>
				presentCollectionSummary(
					ctx,
					collection,
					identity?.subject ?? null,
					await getViewerRole(ctx, collection, identity?.subject ?? null),
					{
						creatorProfile: creatorProfiles.get(collection.creatorId) ?? null
					}
				)
			)
		);
	}
});

export const getCollection = query({
	args: {
		collectionId: v.id('collections')
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId);
		return await buildCollectionDetailPayload(ctx, collection, role, identity?.subject ?? null);
	}
});

export const getCollectionByShareKey = query({
	args: {
		shareKey: v.string()
	},
	handler: async (ctx, args) => {
		const collection = await ctx.db
			.query('collections')
			.withIndex('by_shareKey', (q) => q.eq('shareKey', args.shareKey))
			.unique();
		if (!collection) return null;
		const identity = await ctx.auth.getUserIdentity();
		const viewerUserId = identity?.subject ?? null;
		const role = await getViewerRole(ctx, collection, viewerUserId);
		if (!(await canViewCollection(ctx, collection, role, viewerUserId))) return null;
		return await buildCollectionDetailPayload(ctx, collection, role, viewerUserId);
	}
});

export const getEditableCollectionsForMedia = query({
	args: {
		mediaType: mediaTypeValidator,
		tmdbId: v.number(),
		isAnime: v.boolean()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const collectionEntries = await buildMyCollectionEntries(ctx, identity.subject);
		const creatorProfiles = await getProfilesByUserIds(
			ctx,
			collectionEntries.map(({ collection }) => collection.creatorId)
		);
		const mediaKey = await resolveCollectionMediaKey(ctx, {
			mediaType: args.mediaType,
			tmdbId: args.tmdbId
		});
		return await Promise.all(
			collectionEntries.map(async ({ collection, role }) => {
				const summary = await presentCollectionSummary(ctx, collection, identity.subject, role, {
					creatorProfile: creatorProfiles.get(collection.creatorId) ?? null
				});
				const existingItem = mediaKey
					? await getCollectionItemByMediaKey(ctx, collection._id, mediaKey)
					: null;
				let reason: string | null = null;
				if (existingItem === null && summary.itemCount >= MAX_COLLECTION_ITEMS) {
					reason = collectionItemLimitErrorMessage();
				} else {
					try {
						assertRestrictionsAllowMedia(summary.restrictions, {
							mediaType: args.mediaType,
							isAnime: args.isAnime
						});
					} catch (error) {
						reason =
							error instanceof Error
								? error.message
								: 'This title is not allowed in this collection.';
					}
				}
				return {
					...summary,
					isIncluded: existingItem !== null,
					itemId: existingItem?._id ?? null,
					canAddItem: reason === null,
					blockedReason: reason,
					viewerUserId: identity.subject
				};
			})
		);
	}
});

export const getMediaCollectionState = query({
	args: {
		mediaType: mediaTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const collections = await buildMyCollectionDocuments(ctx, identity.subject);
		const mediaKey = await resolveCollectionMediaKey(ctx, {
			mediaType: args.mediaType,
			tmdbId: args.tmdbId
		});
		if (!mediaKey) {
			return {
				isSaved: false,
				savedCollectionCount: 0
			};
		}

		const matches = await Promise.all(
			collections.map(
				async (collection) =>
					(await getCollectionItemByMediaKey(ctx, collection._id, mediaKey)) !== null
			)
		);

		const savedCollectionCount = matches.filter(Boolean).length;
		return {
			isSaved: savedCollectionCount > 0,
			savedCollectionCount
		};
	}
});

export const create = mutation({
	args: {
		title: v.string(),
		description: v.optional(v.union(v.string(), v.null())),
		visibility: v.optional(visibilityValidator),
		shareAudience: v.optional(shareAudienceValidator),
		layout: v.optional(layoutValidator),
		commentsEnabled: v.optional(v.boolean()),
		restrictions: v.optional(restrictionsValidator),
		defaultSort: v.optional(sortOptionValidator),
		defaultSortDirection: v.optional(sortDirectionValidator),
		collaboratorUserIds: v.optional(v.array(v.string())),
		tiers: v.optional(v.array(tierInputValidator)),
		initialItem: v.optional(addItemInputValidator)
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const now = Date.now();
		const title = normalizeTitle(args.title);
		const description = normalizeDescription(args.description);
		const visibility = args.visibility ?? 'private';
		const shareAudience = normalizeShareAudience(visibility, args.shareAudience);
		const layout = args.layout ?? 'ordered';
		const restrictions = validateRestrictions(args.restrictions ?? defaultRestrictions());
		const defaultSort = args.defaultSort ?? 'custom';
		const defaultSortDirection = args.defaultSortDirection ?? 'descending';
		const resolvedTiers =
			layout === 'tiered' ? sanitizeTierInputs(args.tiers ?? defaultTierDefinitions()) : [];
		const shareKey = makeShareKey({
			creatorId: identity.subject,
			title,
			now
		});
		const collectionId = await ctx.db.insert('collections', {
			creatorId: identity.subject,
			shareKey,
			slug: slugifyTitle(title),
			title,
			description,
			visibility,
			shareAudience,
			layout,
			commentsEnabled: args.commentsEnabled ?? true,
			restrictions,
			defaultSort,
			defaultSortDirection,
			collaboratorCount: 0,
			itemCount: 0,
			likeCount: 0,
			saveCount: 0,
			commentCount: 0,
			viewCount: 0,
			popularityScore: 0,
			coverItems: [],
			lastCommentAt: null,
			lastViewedAt: null,
			activityAt: now,
			createdAt: now,
			updatedAt: now
		});

		const collaboratorUserIds = Array.from(
			new Set((args.collaboratorUserIds ?? []).filter((userId) => userId !== identity.subject))
		);
		if (shareAudience === 'creatorOnly' && collaboratorUserIds.length > 0) {
			throw new Error('Creator-only collections cannot be shared with collaborators.');
		}
		if (collaboratorUserIds.length > MAX_COLLABORATORS) {
			throw new Error(`Collections support at most ${MAX_COLLABORATORS} collaborators.`);
		}
		for (const userId of collaboratorUserIds) {
			const profile = await getProfileByUserId(ctx, userId);
			if (!profile) throw new Error('Collaborators must have an existing profile.');
			await ctx.db.insert('collectionCollaborators', {
				collectionId,
				userId,
				addedByUserId: identity.subject,
				createdAt: now,
				updatedAt: now
			});
		}
		if (collaboratorUserIds.length > 0) {
			await ctx.db.patch(collectionId, { collaboratorCount: collaboratorUserIds.length });
		}

		if (layout === 'tiered') {
			await createDefaultTiers(ctx, collectionId, now, resolvedTiers);
		}

		if (args.initialItem) {
			const media = await loadCanonicalMediaForCollectionItem(ctx, {
				mediaType: args.initialItem.mediaType,
				source: args.initialItem.source,
				externalId: args.initialItem.externalId,
				title: args.initialItem.title,
				posterPath: args.initialItem.posterPath ?? null
			});
			assertRestrictionsAllowMedia(restrictions, media);
			await ctx.db.insert('collectionItems', {
				collectionId,
				mediaType: media.mediaType,
				movieId: media.movieId,
				tvShowId: media.tvShowId,
				tmdbId: media.tmdbId,
				title: media.title,
				posterPath: media.posterPath,
				releaseDate: media.releaseDate,
				isAnime: media.isAnime,
				tierKey: layout === 'tiered' ? (resolvedTiers[0]?.key ?? null) : null,
				sortOrder: ORDER_STEP,
				addedByUserId: identity.subject,
				createdAt: now,
				updatedAt: now
			});
			const createdCollection = await ctx.db.get(collectionId);
			if (createdCollection) {
				await refreshCollectionCoverAndCounts(ctx, createdCollection);
			}
		}

		return collectionId;
	}
});

export const updateMetadata = mutation({
	args: {
		collectionId: v.id('collections'),
		title: v.optional(v.string()),
		description: v.optional(v.union(v.string(), v.null())),
		visibility: v.optional(visibilityValidator),
		shareAudience: v.optional(shareAudienceValidator),
		commentsEnabled: v.optional(v.boolean()),
		restrictions: v.optional(restrictionsValidator),
		defaultSort: v.optional(sortOptionValidator),
		defaultSortDirection: v.optional(sortDirectionValidator)
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		const patch: Partial<CollectionDoc> = {
			updatedAt: Date.now()
		};
		const defaultSortChanged =
			args.defaultSort !== undefined && args.defaultSort !== collection.defaultSort;
		const defaultSortDirectionChanged =
			args.defaultSortDirection !== undefined &&
			args.defaultSortDirection !== resolvedCollectionSortDirection(collection);
		const nextVisibility = args.visibility ?? collection.visibility;
		const nextShareAudience =
			args.visibility !== undefined || args.shareAudience !== undefined
				? normalizeShareAudience(nextVisibility, args.shareAudience ?? collection.shareAudience)
				: normalizeShareAudience(collection.visibility, collection.shareAudience);
		if (args.title !== undefined) {
			const title = normalizeTitle(args.title);
			patch.title = title;
			patch.slug = slugifyTitle(title);
		}
		if (args.description !== undefined) {
			patch.description = normalizeDescription(args.description);
		}
		if (args.defaultSort !== undefined) {
			patch.defaultSort = args.defaultSort;
		}
		if (args.defaultSortDirection !== undefined) {
			patch.defaultSortDirection = args.defaultSortDirection;
		}
		if (args.visibility !== undefined) {
			if (!canChangeVisibility(role)) {
				throw new Error('Only the creator can change collection visibility.');
			}
			patch.visibility = args.visibility;
			patch.shareAudience = nextShareAudience;
		} else if (args.shareAudience !== undefined) {
			if (!canChangeVisibility(role)) {
				throw new Error('Only the creator can change collection sharing settings.');
			}
			patch.shareAudience = nextShareAudience;
		}
		if (args.commentsEnabled !== undefined) {
			if (!canToggleComments(role)) {
				throw new Error('Only the creator can change comment settings.');
			}
			patch.commentsEnabled = args.commentsEnabled;
		}
		if (args.restrictions !== undefined) {
			const restrictions = validateRestrictions(args.restrictions);
			await assertExistingItemsRespectRestrictions(ctx, collection._id, restrictions);
			patch.restrictions = restrictions;
		}
		if (nextVisibility === 'private' && nextShareAudience === 'creatorOnly') {
			await assertCreatorOnlyHasNoSharing(ctx, collection._id);
		}
		await ctx.db.patch(collection._id, patch);
		if (defaultSortChanged || defaultSortDirectionChanged) {
			await refreshCollectionCoverAndCounts(ctx, {
				...collection,
				...patch
			});
		}
		return await presentCollectionSummary(
			ctx,
			(await ctx.db.get(collection._id))!,
			identity?.subject ?? null,
			role
		);
	}
});

export const updateLayout = mutation({
	args: {
		collectionId: v.id('collections'),
		layout: layoutValidator
	},
	handler: async (ctx, args) => {
		const { collection } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		if (collection.layout === args.layout) return collection._id;
		if (collection.layout === 'tiered' || args.layout === 'tiered') {
			throw new Error('Tiered collections cannot be converted to or from another layout.');
		}
		await ctx.db.patch(collection._id, {
			layout: args.layout,
			updatedAt: Date.now()
		});
		await refreshCollectionCoverAndCounts(ctx, {
			...collection,
			layout: args.layout,
			updatedAt: Date.now()
		});
		return collection._id;
	}
});

export const replaceTiers = mutation({
	args: {
		collectionId: v.id('collections'),
		tiers: v.array(tierInputValidator)
	},
	handler: async (ctx, args) => {
		const { collection } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		if (collection.layout !== 'tiered') {
			throw new Error('Only tiered collections can update tiers.');
		}
		const nextTiers = sanitizeTierInputs(args.tiers);
		const existingTiers = await loadCollectionTiers(ctx, collection._id);
		const existingByKey = new Map(existingTiers.map((tier) => [tier.key, tier] as const));
		const nextKeys = new Set(nextTiers.map((tier) => tier.key));
		const items = await loadCollectionItems(ctx, collection._id);
		for (const item of items) {
			if (item.tierKey != null && !nextKeys.has(item.tierKey)) {
				throw new Error('Move items out of removed tiers before deleting those tiers.');
			}
		}
		const now = Date.now();
		for (const [index, tier] of nextTiers.entries()) {
			const existing = existingByKey.get(tier.key);
			if (existing) {
				await ctx.db.patch(existing._id, {
					label: tier.label,
					sortOrder: (index + 1) * ORDER_STEP,
					updatedAt: now
				});
			} else {
				await ctx.db.insert('collectionTiers', {
					collectionId: collection._id,
					key: tier.key,
					label: tier.label,
					sortOrder: (index + 1) * ORDER_STEP,
					createdAt: now,
					updatedAt: now
				});
			}
		}
		for (const tier of existingTiers) {
			if (!nextKeys.has(tier.key)) {
				await ctx.db.delete(tier._id);
			}
		}
		await ctx.db.patch(collection._id, { updatedAt: now });
		await refreshCollectionCoverAndCounts(ctx, {
			...collection,
			updatedAt: now
		});
		return collection._id;
	}
});

export const addCollaborator = mutation({
	args: {
		collectionId: v.id('collections'),
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		const actorUserId = identity?.subject;
		if (!actorUserId) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}
		if (!canInviteCollaborators(role)) {
			throw new Error('Only the creator or collaborators can invite collaborators.');
		}
		if (isCreatorOnlyPrivateCollection(collection)) {
			throw new Error('Creator-only collections cannot be shared.');
		}
		if (collection.creatorId === args.userId) {
			throw new Error('The creator is already part of this collection.');
		}
		const existing = await getCollaboratorRow(ctx, collection._id, args.userId);
		if (existing) return existing._id;
		if (collection.collaboratorCount >= MAX_COLLABORATORS) {
			throw new Error(`Collections support at most ${MAX_COLLABORATORS} collaborators.`);
		}
		const profile = await getProfileByUserId(ctx, args.userId);
		if (!profile) throw new Error('This user is not available for collaboration yet.');
		const now = Date.now();
		const rowId = await ctx.db.insert('collectionCollaborators', {
			collectionId: collection._id,
			userId: args.userId,
			addedByUserId: actorUserId,
			createdAt: now,
			updatedAt: now
		});
		const viewerInvite = await getViewerInviteRow(ctx, collection._id, args.userId);
		if (viewerInvite) {
			await ctx.db.delete(viewerInvite._id);
		}
		await ctx.db.patch(collection._id, {
			collaboratorCount: collection.collaboratorCount + 1,
			updatedAt: now
		});
		return rowId;
	}
});

export const removeCollaborator = mutation({
	args: {
		collectionId: v.id('collections'),
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		if (!identity || !canRemoveCollaborator(role, args.userId, identity.subject)) {
			throw new Error('Only the creator can remove other collaborators.');
		}
		const collaborator = await getCollaboratorRow(ctx, collection._id, args.userId);
		if (!collaborator) return false;
		const now = Date.now();
		await ctx.db.delete(collaborator._id);
		await ctx.db.patch(collection._id, {
			collaboratorCount: Math.max(0, collection.collaboratorCount - 1),
			updatedAt: now
		});
		return true;
	}
});

export const addViewerInvite = mutation({
	args: {
		collectionId: v.id('collections'),
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		const actorUserId = identity?.subject;
		if (!actorUserId) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}
		if (!canInviteCollaborators(role)) {
			throw new Error('Only the creator or collaborators can invite viewers.');
		}
		if (collection.visibility !== 'private') {
			throw new Error('Viewer invites only apply to private collections.');
		}
		if (isCreatorOnlyPrivateCollection(collection)) {
			throw new Error('Creator-only collections cannot be shared.');
		}
		if (collection.creatorId === args.userId) {
			throw new Error('The creator already has access to this collection.');
		}
		const collaborator = await getCollaboratorRow(ctx, collection._id, args.userId);
		if (collaborator) {
			throw new Error('Collaborators already have access to this collection.');
		}
		const existing = await getViewerInviteRow(ctx, collection._id, args.userId);
		if (existing) return existing._id;
		const inviteRows = await ctx.db
			.query('collectionViewerInvites')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collection._id))
			.take(MAX_VIEWER_INVITES);
		if (inviteRows.length >= MAX_VIEWER_INVITES) {
			throw new Error(`Collections support at most ${MAX_VIEWER_INVITES} invited viewers.`);
		}
		const profile = await getProfileByUserId(ctx, args.userId);
		if (!profile) throw new Error('This user is not available yet.');
		const now = Date.now();
		return await ctx.db.insert('collectionViewerInvites', {
			collectionId: collection._id,
			userId: args.userId,
			addedByUserId: actorUserId,
			createdAt: now,
			updatedAt: now
		});
	}
});

export const removeViewerInvite = mutation({
	args: {
		collectionId: v.id('collections'),
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const { collection, role } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		if (!canInviteCollaborators(role)) {
			throw new Error('Only the creator or collaborators can remove invited viewers.');
		}
		const invite = await getViewerInviteRow(ctx, collection._id, args.userId);
		if (!invite) return false;
		await ctx.db.delete(invite._id);
		return true;
	}
});

export const leaveCollection = mutation({
	args: {
		collectionId: v.id('collections')
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const { collection, role } = await requireCollectionAccess(ctx, args.collectionId);
		if (role === 'creator') {
			throw new Error('Creators cannot leave their own collections.');
		}

		const collaborator = await getCollaboratorRow(ctx, collection._id, identity.subject);
		if (collaborator) {
			const now = Date.now();
			await ctx.db.delete(collaborator._id);
			await ctx.db.patch(collection._id, {
				collaboratorCount: Math.max(0, collection.collaboratorCount - 1),
				updatedAt: now
			});
			return true;
		}

		const viewerInvite = await getViewerInviteRow(ctx, collection._id, identity.subject);
		if (viewerInvite) {
			await ctx.db.delete(viewerInvite._id);
			return true;
		}

		throw new Error('You do not have removable access to this collection.');
	}
});

export const addItem = mutation({
	args: {
		collectionId: v.id('collections'),
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const { collection, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		const actorUserId = identity?.subject;
		if (!actorUserId) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}
		const media = await loadCanonicalMediaForCollectionItem(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId,
			title: args.title,
			posterPath: args.posterPath ?? null
		});
		assertRestrictionsAllowMedia(collection.restrictions, media);

		const existing =
			media.mediaType === 'movie'
				? await ctx.db
						.query('collectionItems')
						.withIndex('by_collectionId_movieId', (q) =>
							q.eq('collectionId', collection._id).eq('movieId', media.movieId)
						)
						.unique()
				: await ctx.db
						.query('collectionItems')
						.withIndex('by_collectionId_tvShowId', (q) =>
							q.eq('collectionId', collection._id).eq('tvShowId', media.tvShowId)
						)
						.unique();
		if (existing) return existing._id;

		if (await hasReachedCollectionItemLimit(ctx, collection)) {
			throw new Error(collectionItemLimitErrorMessage());
		}

		const contextTierKey =
			collection.layout === 'tiered'
				? ((await loadCollectionTiers(ctx, collection._id))[0]?.key ?? null)
				: null;
		const contextItems = await loadCollectionItemsForTier(ctx, collection._id, contextTierKey);
		const maxSort = contextItems.reduce((max, item) => Math.max(max, item.sortOrder), 0);
		const now = Date.now();
		const itemId = await ctx.db.insert('collectionItems', {
			collectionId: collection._id,
			mediaType: media.mediaType,
			movieId: media.movieId,
			tvShowId: media.tvShowId,
			tmdbId: media.tmdbId,
			title: media.title,
			posterPath: media.posterPath,
			releaseDate: media.releaseDate,
			isAnime: media.isAnime,
			tierKey: contextTierKey,
			sortOrder: maxSort + ORDER_STEP,
			addedByUserId: actorUserId,
			createdAt: now,
			updatedAt: now
		});
		await ctx.db.patch(collection._id, {
			updatedAt: now,
			activityAt: now
		});
		await refreshCollectionCoverAndCounts(ctx, collection);
		return itemId;
	}
});

export const removeItem = mutation({
	args: {
		itemId: v.id('collectionItems')
	},
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item) return false;
		const { collection } = await requireCollectionAccess(ctx, item.collectionId, {
			requireEdit: true
		});
		const now = Date.now();
		await ctx.db.delete(item._id);
		await ctx.db.patch(collection._id, {
			updatedAt: now,
			activityAt: now
		});
		await refreshCollectionCoverAndCounts(ctx, collection);
		return true;
	}
});

export const moveItem = mutation({
	args: {
		itemId: v.id('collectionItems'),
		beforeItemId: v.optional(v.union(v.id('collectionItems'), v.null())),
		afterItemId: v.optional(v.union(v.id('collectionItems'), v.null())),
		destinationTierKey: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item) throw new Error('Collection item not found.');
		const { collection } = await requireCollectionAccess(ctx, item.collectionId, {
			requireEdit: true
		});
		const destinationTierKey =
			collection.layout === 'tiered' ? (args.destinationTierKey ?? item.tierKey ?? null) : null;
		if (
			collection.layout !== 'tiered' &&
			args.destinationTierKey !== undefined &&
			args.destinationTierKey !== null
		) {
			throw new Error('Only tiered collections can move items between tiers.');
		}
		if (collection.layout === 'tiered') {
			const tiers = await loadCollectionTiers(ctx, collection._id);
			if (!tiers.some((tier) => tier.key === destinationTierKey)) {
				throw new Error('Destination tier not found.');
			}
		}
		const [beforeItem, afterItem] = await Promise.all([
			args.beforeItemId ? ctx.db.get(args.beforeItemId) : Promise.resolve(null),
			args.afterItemId ? ctx.db.get(args.afterItemId) : Promise.resolve(null)
		]);
		for (const neighbor of [beforeItem, afterItem]) {
			if (neighbor && neighbor.collectionId !== collection._id) {
				throw new Error('Cannot reorder across collections.');
			}
			if (neighbor && neighbor.tierKey !== destinationTierKey) {
				throw new Error('Reorder neighbors must be in the same tier.');
			}
		}
		if (maybeNeedsRebalance(beforeItem?.sortOrder ?? null, afterItem?.sortOrder ?? null)) {
			await rebalanceCollectionItems(ctx, collection._id, destinationTierKey);
		}
		const refreshedBefore = args.beforeItemId ? await ctx.db.get(args.beforeItemId!) : null;
		const refreshedAfter = args.afterItemId ? await ctx.db.get(args.afterItemId!) : null;
		const sortOrder = computeSortOrderBetween(
			refreshedBefore?.sortOrder ?? null,
			refreshedAfter?.sortOrder ?? null
		);
		const now = Date.now();
		await ctx.db.patch(item._id, {
			tierKey: destinationTierKey,
			sortOrder,
			updatedAt: now
		});
		await ctx.db.patch(collection._id, {
			updatedAt: now,
			activityAt: now
		});
		await refreshCollectionCoverAndCounts(ctx, collection);
		return item._id;
	}
});

export const deleteCollection = mutation({
	args: {
		collectionId: v.id('collections')
	},
	handler: async (ctx, args) => {
		const { collection, role } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		if (role !== 'creator') {
			throw new Error('Only the creator can delete this collection.');
		}

		await deleteCollectionRecords(ctx, collection._id);
		await ctx.db.delete(collection._id);
		return true;
	}
});

export const setLike = mutation({
	args: {
		collectionId: v.id('collections'),
		value: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const { collection } = await requireCollectionAccess(ctx, args.collectionId);
		const existing = await ctx.db
			.query('collectionLikes')
			.withIndex('by_collectionId_userId', (q) =>
				q.eq('collectionId', collection._id).eq('userId', identity.subject)
			)
			.unique();
		const nextValue = args.value ?? existing === null;
		if (nextValue && !existing) {
			const now = Date.now();
			await ctx.db.insert('collectionLikes', {
				collectionId: collection._id,
				userId: identity.subject,
				createdAt: now
			});
			await patchCollectionMetrics(ctx, collection, {
				likeCount: collection.likeCount + 1,
				activityAt: now
			});
			return true;
		}
		if (!nextValue && existing) {
			await ctx.db.delete(existing._id);
			await patchCollectionMetrics(ctx, collection, {
				likeCount: Math.max(0, collection.likeCount - 1)
			});
		}
		return false;
	}
});

export const setSave = mutation({
	args: {
		collectionId: v.id('collections'),
		value: v.optional(v.boolean())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const { collection, role } = await requireCollectionAccess(ctx, args.collectionId);
		if (!canSaveCollection(collection, role)) {
			throw new Error('Only other users can save public collections.');
		}
		const existing = await ctx.db
			.query('collectionSaves')
			.withIndex('by_collectionId_userId', (q) =>
				q.eq('collectionId', collection._id).eq('userId', identity.subject)
			)
			.unique();
		const nextValue = args.value ?? existing === null;
		if (nextValue && !existing) {
			const now = Date.now();
			await ctx.db.insert('collectionSaves', {
				collectionId: collection._id,
				userId: identity.subject,
				createdAt: now
			});
			await patchCollectionMetrics(ctx, collection, {
				saveCount: collection.saveCount + 1,
				activityAt: now
			});
			return true;
		}
		if (!nextValue && existing) {
			await ctx.db.delete(existing._id);
			await patchCollectionMetrics(ctx, collection, {
				saveCount: Math.max(0, collection.saveCount - 1)
			});
		}
		return false;
	}
});

export const addComment = mutation({
	args: {
		collectionId: v.id('collections'),
		body: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const { collection } = await requireCollectionAccess(ctx, args.collectionId);
		if (!collection.commentsEnabled) {
			throw new Error('Comments are disabled for this collection.');
		}
		const now = Date.now();
		const commentId = await ctx.db.insert('collectionComments', {
			collectionId: collection._id,
			userId: identity.subject,
			body: normalizeCommentBody(args.body),
			createdAt: now,
			updatedAt: now
		});
		await patchCollectionMetrics(ctx, collection, {
			commentCount: collection.commentCount + 1,
			lastCommentAt: now,
			activityAt: now
		});
		return commentId;
	}
});

export const deleteComment = mutation({
	args: {
		commentId: v.id('collectionComments')
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const comment = await ctx.db.get(args.commentId);
		if (!comment) return false;
		const { collection, role } = await requireCollectionAccess(ctx, comment.collectionId);
		const canDelete =
			comment.userId === identity.subject || role === 'creator' || role === 'collaborator';
		if (!canDelete) {
			throw new Error('Only the author, creator, or collaborators can remove comments.');
		}
		const now = Date.now();
		await ctx.db.delete(comment._id);
		const latestRemainingComment = await ctx.db
			.query('collectionComments')
			.withIndex('by_collectionId_createdAt', (q) => q.eq('collectionId', collection._id))
			.order('desc')
			.take(1);
		await patchCollectionMetrics(ctx, collection, {
			commentCount: Math.max(0, collection.commentCount - 1),
			lastCommentAt: latestRemainingComment[0]?.createdAt ?? null,
			activityAt: now
		});
		return true;
	}
});

export const cloneCollection = mutation({
	args: {
		collectionId: v.id('collections'),
		title: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const { collection, role } = await requireCollectionAccess(ctx, args.collectionId);
		if (!canCloneCollection(collection, role)) {
			throw new Error('This collection cannot be cloned.');
		}
		const [items, tiers] = await Promise.all([
			loadCollectionItems(ctx, collection._id),
			collection.layout === 'tiered'
				? loadCollectionTiers(ctx, collection._id)
				: Promise.resolve([] as CollectionTierDoc[])
		]);
		if (items.length > MAX_COLLECTION_ITEMS) {
			throw new Error(
				`Collections can include at most ${MAX_COLLECTION_ITEMS} items, so this collection cannot be cloned as-is.`
			);
		}
		const now = Date.now();
		const title = normalizeTitle(args.title ?? `${collection.title} Copy`);
		const cloneId = await ctx.db.insert('collections', {
			creatorId: identity.subject,
			shareKey: makeShareKey({ creatorId: identity.subject, title, now }),
			slug: slugifyTitle(title),
			title,
			description: collection.description,
			visibility: 'private',
			shareAudience: 'anyone',
			layout: collection.layout,
			commentsEnabled: collection.commentsEnabled,
			restrictions: collection.restrictions,
			defaultSort: collection.defaultSort,
			defaultSortDirection: resolvedCollectionSortDirection(collection),
			clonedFromCollectionId: collection._id,
			clonedFromShareKey: collection.shareKey,
			collaboratorCount: 0,
			itemCount: 0,
			likeCount: 0,
			saveCount: 0,
			commentCount: 0,
			viewCount: 0,
			popularityScore: 0,
			coverItems: [],
			lastCommentAt: null,
			lastViewedAt: null,
			activityAt: now,
			createdAt: now,
			updatedAt: now
		});
		for (const tier of tiers.sort((left, right) => left.sortOrder - right.sortOrder)) {
			await ctx.db.insert('collectionTiers', {
				collectionId: cloneId,
				key: tier.key,
				label: tier.label,
				sortOrder: tier.sortOrder,
				createdAt: now,
				updatedAt: now
			});
		}
		for (const item of items) {
			await ctx.db.insert('collectionItems', {
				collectionId: cloneId,
				mediaType: item.mediaType,
				movieId: item.movieId,
				tvShowId: item.tvShowId,
				tmdbId: item.tmdbId,
				title: item.title,
				posterPath: item.posterPath,
				releaseDate: item.releaseDate,
				isAnime: item.isAnime,
				tierKey: item.tierKey,
				sortOrder: item.sortOrder,
				addedByUserId: identity.subject,
				createdAt: now,
				updatedAt: now
			});
		}
		const clone = await ctx.db.get(cloneId);
		if (clone) {
			await refreshCollectionCoverAndCounts(ctx, clone);
		}
		return cloneId;
	}
});

export const trackView = mutation({
	args: {
		collectionId: v.id('collections'),
		viewerKey: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const collection = await ctx.db.get(args.collectionId);
		if (!collection) return false;
		const identity = await ctx.auth.getUserIdentity();
		const role = await getViewerRole(ctx, collection, identity?.subject ?? null);
		if (!(await canViewCollection(ctx, collection, role, identity?.subject ?? null))) return false;

		const viewerKey = identity?.subject ?? args.viewerKey?.trim() ?? null;
		if (!viewerKey) return false;

		const now = Date.now();
		const windowStart = Math.floor(now / VIEW_WINDOW_MS) * VIEW_WINDOW_MS;
		const existing = await ctx.db
			.query('collectionViews')
			.withIndex('by_collectionId_viewerKey_windowStart', (q) =>
				q
					.eq('collectionId', collection._id)
					.eq('viewerKey', viewerKey)
					.eq('windowStart', windowStart)
			)
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, { lastViewedAt: now });
			return false;
		}
		await ctx.db.insert('collectionViews', {
			collectionId: collection._id,
			viewerKey,
			windowStart,
			createdAt: now,
			lastViewedAt: now
		});
		await patchCollectionMetrics(ctx, collection, {
			viewCount: collection.viewCount + 1,
			lastViewedAt: now,
			activityAt: now
		});
		return true;
	}
});

export const cleanupCollectionViewWindows = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const staleBefore = args.now - VIEW_RETENTION_MS;
		const rows = await ctx.db
			.query('collectionViews')
			.withIndex('by_createdAt', (q) => q.lt('createdAt', staleBefore))
			.take(args.limit ?? 200);
		for (const row of rows) {
			await ctx.db.delete(row._id);
		}
		return { deleted: rows.length };
	}
});

export const cleanupCollectionViewWindowsNow = internalAction({
	args: {},
	handler: async (ctx): Promise<{ deleted: number }> => {
		return await ctx.runMutation(internal.collections.cleanupCollectionViewWindows, {
			now: Date.now(),
			limit: 300
		});
	}
});
