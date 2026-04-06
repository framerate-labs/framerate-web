import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import { ensureMediaRecord, scheduleDetailHydrationForTMDB } from './services/reviewService';
import { getFinalMovie, getFinalTV } from './utils/mediaLookup';

const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_COMMENT_LENGTH = 1000;
const MAX_COLLABORATORS = 32;
const MAX_VIEWER_INVITES = 256;
const MAX_TIERS = 20;
const MAX_VISIBLE_COMMENTS = 100;
const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const VIEW_RETENTION_MS = 45 * VIEW_WINDOW_MS;
const REBALANCE_GAP_MIN = 0.000001;
const ORDER_STEP = 1024;
const COLLECTION_COVER_PREVIEW_LIMIT = 3;

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

type CollectionCollaboratorDoc = Doc<'collectionCollaborators'>;
type CollectionItemDoc = Doc<'collectionItems'>;
type CollectionTierDoc = Doc<'collectionTiers'>;
type CollectionCommentDoc = Doc<'collectionComments'>;
type CollectionViewerInviteDoc = Doc<'collectionViewerInvites'>;
type UserProfileDoc = Doc<'userProfiles'>;
type ShareAudience = 'creatorOnly' | 'anyone' | 'friends' | 'followers';
type CollectionDoc = Doc<'collections'> & { shareAudience?: ShareAudience };
type ViewerRole = 'creator' | 'collaborator' | 'viewer' | 'none';
type CollectionMediaKey =
	| { mediaType: 'movie'; movieId: Id<'movies'> }
	| { mediaType: 'tv'; tvShowId: Id<'tvShows'> };

type Restrictions = CollectionDoc['restrictions'];

function normalizeTitle(value: string): string {
	const trimmed = value.trim().replace(/\s+/g, ' ');
	if (trimmed.length === 0) throw new Error('Collection title is required.');
	if (trimmed.length > MAX_TITLE_LENGTH) {
		throw new Error(`Collection title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

function normalizeDescription(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(
			`Collection description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`
		);
	}
	return trimmed;
}

function normalizeCommentBody(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error('Comment cannot be empty.');
	if (trimmed.length > MAX_COMMENT_LENGTH) {
		throw new Error(`Comment must be ${MAX_COMMENT_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

function slugifyTitle(title: string): string {
	const base = title
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return base.length > 0 ? base.slice(0, 64) : 'collection';
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function makeShareKey(args: { creatorId: string; title: string; now: number }): string {
	const suffix = hashString(`${args.creatorId}:${args.title}:${args.now}`).toString(36).slice(0, 6);
	const creatorSuffix =
		args.creatorId
			.replace(/[^a-zA-Z0-9]/g, '')
			.slice(-6)
			.toLowerCase() || 'user';
	return `${args.now.toString(36)}-${creatorSuffix}-${suffix}`;
}

function defaultRestrictions(): Restrictions {
	return {
		allowMovies: true,
		allowTV: true,
		allowAnime: true,
		allowNonAnime: true
	};
}

function normalizeShareAudience(
	visibility: CollectionDoc['visibility'] | 'private' | 'public',
	value: ShareAudience | null | undefined
): ShareAudience {
	if (visibility === 'public') return 'anyone';
	return value ?? 'anyone';
}

function isCreatorOnlyPrivateCollection(collection: CollectionDoc): boolean {
	return (
		collection.visibility === 'private' &&
		normalizeShareAudience(collection.visibility, collection.shareAudience) === 'creatorOnly'
	);
}

function validateRestrictions(restrictions: Restrictions): Restrictions {
	if (!restrictions.allowMovies && !restrictions.allowTV) {
		throw new Error('Collections must allow at least one media type.');
	}
	if (!restrictions.allowAnime && !restrictions.allowNonAnime) {
		throw new Error('Collections must allow anime, non-anime, or both.');
	}
	return restrictions;
}

function defaultTierDefinitions(): Array<{ key: string; label: string }> {
	return [
		{ key: 's', label: 'S' },
		{ key: 'a', label: 'A' },
		{ key: 'b', label: 'B' },
		{ key: 'c', label: 'C' },
		{ key: 'd', label: 'D' },
		{ key: 'f', label: 'F' }
	];
}

function sanitizeTierInputs(
	tiers: Array<{ key: string; label: string }>
): Array<{ key: string; label: string }> {
	if (tiers.length === 0) throw new Error('Tiered collections must include at least one tier.');
	if (tiers.length > MAX_TIERS) throw new Error(`Collections support at most ${MAX_TIERS} tiers.`);
	const deduped = new Set<string>();
	return tiers.map((tier) => {
		const key = tier.key.trim().toLowerCase();
		const label = tier.label.trim();
		if (key.length === 0) throw new Error('Tier keys are required.');
		if (label.length === 0) throw new Error('Tier labels are required.');
		if (deduped.has(key)) throw new Error('Tier keys must be unique.');
		deduped.add(key);
		return { key, label };
	});
}

function computePopularityScore(
	collection: Pick<CollectionDoc, 'likeCount' | 'saveCount' | 'commentCount' | 'viewCount'>
): number {
	return (
		collection.viewCount +
		collection.likeCount * 8 +
		collection.saveCount * 12 +
		collection.commentCount * 6
	);
}

async function requireIdentity(ctx: QueryCtx | MutationCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Unauthorized: Please login or signup to continue');
	}
	return identity;
}

async function getProfileByUserId(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<UserProfileDoc | null> {
	return await ctx.db
		.query('userProfiles')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.unique();
}

async function getProfilesByUserIds(
	ctx: QueryCtx | MutationCtx,
	userIds: string[]
): Promise<Map<string, UserProfileDoc | null>> {
	const deduped = Array.from(new Set(userIds));
	const rows = await Promise.all(
		deduped.map(async (userId) => [userId, await getProfileByUserId(ctx, userId)] as const)
	);
	return new Map(rows);
}

function presentProfile(profile: UserProfileDoc | null, userId: string) {
	return {
		userId,
		displayName: profile?.displayName ?? 'Unknown User',
		email: profile?.email ?? null,
		profilePictureUrl: profile?.profilePictureUrl ?? null
	};
}

async function getCollaboratorRow(
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

async function getViewerInviteRow(
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

async function getFollowRow(
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

async function getViewerRole(
	ctx: QueryCtx | MutationCtx,
	collection: CollectionDoc,
	userId: string | null
): Promise<ViewerRole> {
	if (!userId) return 'none';
	if (collection.creatorId === userId) return 'creator';
	const collaborator = await getCollaboratorRow(ctx, collection._id, userId);
	return collaborator ? 'collaborator' : 'viewer';
}

function canEditCollection(role: ViewerRole): boolean {
	return role === 'creator' || role === 'collaborator';
}

function canChangeVisibility(role: ViewerRole): boolean {
	return role === 'creator';
}

function canToggleComments(role: ViewerRole): boolean {
	return role === 'creator';
}

function canInviteCollaborators(role: ViewerRole): boolean {
	return role === 'creator' || role === 'collaborator';
}

function canRemoveCollaborator(
	role: ViewerRole,
	targetUserId: string,
	actorUserId: string
): boolean {
	if (targetUserId === actorUserId) return true;
	return role === 'creator';
}

function canSaveCollection(collection: CollectionDoc, role: ViewerRole): boolean {
	if (role === 'creator' || role === 'collaborator') return false;
	return collection.visibility === 'public';
}

function canCloneCollection(collection: CollectionDoc, role: ViewerRole): boolean {
	return canEditCollection(role) || collection.visibility === 'public';
}

async function viewerMatchesShareAudience(
	ctx: QueryCtx | MutationCtx,
	collection: CollectionDoc,
	viewerUserId: string | null
): Promise<boolean> {
	if (collection.visibility === 'public') return true;
	if (isCreatorOnlyPrivateCollection(collection)) return false;
	if (viewerUserId) {
		const directInvite = await getViewerInviteRow(ctx, collection._id, viewerUserId);
		if (directInvite) return true;
	}
	switch (normalizeShareAudience(collection.visibility, collection.shareAudience)) {
		case 'creatorOnly':
			return false;
		case 'anyone':
			return true;
		case 'friends': {
			if (!viewerUserId) return false;
			const [viewerFollowsCreator, creatorFollowsViewer] = await Promise.all([
				getFollowRow(ctx, viewerUserId, collection.creatorId),
				getFollowRow(ctx, collection.creatorId, viewerUserId)
			]);
			return viewerFollowsCreator !== null && creatorFollowsViewer !== null;
		}
		case 'followers': {
			if (!viewerUserId) return false;
			const follow = await getFollowRow(ctx, viewerUserId, collection.creatorId);
			return follow !== null;
		}
	}
}

async function canViewCollection(
	ctx: QueryCtx | MutationCtx,
	collection: CollectionDoc,
	role: ViewerRole,
	viewerUserId: string | null
): Promise<boolean> {
	if (role === 'creator') return true;
	if (isCreatorOnlyPrivateCollection(collection)) return false;
	if (role === 'collaborator') return true;
	return await viewerMatchesShareAudience(ctx, collection, viewerUserId);
}

async function requireCollectionAccess(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	options?: { requireEdit?: boolean }
) {
	const collection = await ctx.db.get(collectionId);
	if (!collection) throw new Error('Collection not found.');
	const identity = await ctx.auth.getUserIdentity();
	const viewerUserId = identity?.subject ?? null;
	const role = await getViewerRole(ctx, collection, viewerUserId);
	if (!(await canViewCollection(ctx, collection, role, viewerUserId))) {
		throw new Error('Collection not found.');
	}
	if (options?.requireEdit && !canEditCollection(role)) {
		throw new Error('Only the creator or collaborators can edit this collection.');
	}
	return { collection, role, identity };
}

async function loadCollectionItems(ctx: QueryCtx | MutationCtx, collectionId: Id<'collections'>) {
	return await ctx.db
		.query('collectionItems')
		.withIndex('by_collectionId_sortOrder', (q) => q.eq('collectionId', collectionId))
		.collect();
}

async function loadCollectionItemsForTier(
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

async function loadCollectionTiers(ctx: QueryCtx | MutationCtx, collectionId: Id<'collections'>) {
	return await ctx.db
		.query('collectionTiers')
		.withIndex('by_collectionId_sortOrder', (q) => q.eq('collectionId', collectionId))
		.collect();
}

async function assertCreatorOnlyHasNoSharing(ctx: MutationCtx, collectionId: Id<'collections'>) {
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

function assertRestrictionsAllowMedia(
	restrictions: Restrictions,
	media: { mediaType: 'movie' | 'tv'; isAnime: boolean }
) {
	if (media.mediaType === 'movie' && !restrictions.allowMovies) {
		throw new Error('This collection does not allow movies.');
	}
	if (media.mediaType === 'tv' && !restrictions.allowTV) {
		throw new Error('This collection does not allow series.');
	}
	if (media.isAnime && !restrictions.allowAnime) {
		throw new Error('This collection does not allow anime titles.');
	}
	if (!media.isAnime && !restrictions.allowNonAnime) {
		throw new Error('This collection does not allow non-anime titles.');
	}
}

async function assertExistingItemsRespectRestrictions(
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

function computeSortOrderBetween(previous: number | null, next: number | null): number {
	if (previous == null && next == null) return ORDER_STEP;
	if (previous == null) return next! - ORDER_STEP;
	if (next == null) return previous + ORDER_STEP;
	const midpoint = (previous + next) / 2;
	if (!Number.isFinite(midpoint)) {
		throw new Error('Unable to compute collection order.');
	}
	return midpoint;
}

async function rebalanceCollectionItems(
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

function maybeNeedsRebalance(previous: number | null, next: number | null): boolean {
	if (previous == null || next == null) return false;
	return Math.abs(next - previous) < REBALANCE_GAP_MIN;
}

async function refreshCollectionCoverAndCounts(ctx: MutationCtx, collection: CollectionDoc) {
	const tiers =
		collection.layout === 'tiered' ? await loadCollectionTiers(ctx, collection._id) : [];
	const tierRank = new Map(tiers.map((tier, index) => [tier.key, index] as const));
	const items = (await loadCollectionItems(ctx, collection._id)).sort((left, right) => {
		if (left.tierKey !== right.tierKey) {
			if (left.tierKey == null) return -1;
			if (right.tierKey == null) return 1;
			return (
				(tierRank.get(left.tierKey) ?? Number.MAX_SAFE_INTEGER) -
				(tierRank.get(right.tierKey) ?? Number.MAX_SAFE_INTEGER)
			);
		}
		return left.sortOrder - right.sortOrder;
	});
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

async function patchCollectionMetrics(
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

async function createDefaultTiers(
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

async function resolveCollectionMediaKey(
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

async function getCollectionItemByMediaKey(
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

async function presentCollectionSummary(
	ctx: QueryCtx,
	collection: CollectionDoc,
	userId: string | null,
	role: ViewerRole
) {
	const creatorProfile = await getProfileByUserId(ctx, collection.creatorId);
	let isLiked = false;
	let isSaved = false;
	if (userId) {
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
		isLiked = likeRow !== null;
		isSaved = saveRow !== null;
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

async function buildMyCollectionSummaries(ctx: QueryCtx, userId: string) {
	const merged = await buildMyCollectionEntries(ctx, userId);
	return await Promise.all(
		merged.map(async ({ collection, role }) =>
			presentCollectionSummary(ctx, collection, userId, role)
		)
	);
}

async function buildMyCollectionEntries(
	ctx: QueryCtx,
	userId: string
): Promise<Array<{ collection: CollectionDoc; role: ViewerRole }>> {
	const created = await ctx.db
		.query('collections')
		.withIndex('by_creatorId_updatedAt', (q) => q.eq('creatorId', userId))
		.order('desc')
		.collect();
	const collaboratorRows = await ctx.db
		.query('collectionCollaborators')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.collect();
	const collaboratorCollections = await Promise.all(
		collaboratorRows.map(async (row) => ctx.db.get(row.collectionId))
	);

	const merged = new Map<Id<'collections'>, { collection: CollectionDoc; role: ViewerRole }>();
	for (const collection of created) {
		merged.set(collection._id, { collection, role: 'creator' });
	}
	for (const collection of collaboratorCollections) {
		if (collection && !merged.has(collection._id)) {
			merged.set(collection._id, { collection, role: 'collaborator' });
		}
	}

	return Array.from(merged.values()).sort(
		(left, right) => right.collection.updatedAt - left.collection.updatedAt
	);
}

async function buildMyCollectionDocuments(ctx: QueryCtx, userId: string) {
	return (await buildMyCollectionEntries(ctx, userId)).map(({ collection }) => collection);
}

async function buildCollectionDetailPayload(
	ctx: QueryCtx,
	collection: CollectionDoc,
	role: ViewerRole,
	userId: string | null
) {
	const [collaborators, items, tiers, comments] = await Promise.all([
		ctx.db
			.query('collectionCollaborators')
			.withIndex('by_collectionId', (q) => q.eq('collectionId', collection._id))
			.collect(),
		loadCollectionItems(ctx, collection._id),
		collection.layout === 'tiered'
			? loadCollectionTiers(ctx, collection._id)
			: Promise.resolve([] as CollectionTierDoc[]),
		ctx.db
			.query('collectionComments')
			.withIndex('by_collectionId_createdAt', (q) => q.eq('collectionId', collection._id))
			.order('desc')
			.take(MAX_VISIBLE_COMMENTS)
	]);
	const profileIds = [
		collection.creatorId,
		...collaborators.map((row) => row.userId),
		...comments.map((comment) => comment.userId)
	];
	const profiles = await getProfilesByUserIds(ctx, profileIds);
	const presented = await presentCollectionSummary(ctx, collection, userId, role);
	const presentedItems = sortItemsForPresentation(items, collection.layout, tiers);
	return {
		...presented,
		collaborators: collaborators.map((row) =>
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

async function loadCanonicalMediaForCollectionItem(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number | string;
		title: string;
		posterPath: string | null;
	}
) {
	const now = Date.now();
	const ensured = await ensureMediaRecord(ctx, {
		mediaType: args.mediaType,
		source: args.source,
		externalId: args.externalId,
		title: args.title,
		posterPath: args.posterPath,
		now
	});

	if (ensured.shouldHydrateDetails) {
		await scheduleDetailHydrationForTMDB(ctx, args.mediaType, args.source, args.externalId);
	}

	if (ensured.mediaType === 'movie') {
		const base = await ctx.db.get(ensured.mediaId);
		if (!base) throw new Error('Movie not found.');
		const movie = await getFinalMovie(ctx, base);
		if (movie.isAnime == null) {
			throw new Error('This title is still being enriched. Try again in a moment.');
		}
		return {
			mediaType: 'movie' as const,
			movieId: ensured.mediaId,
			tvShowId: null,
			tmdbId: movie.tmdbId ?? null,
			title: movie.title,
			posterPath: movie.posterPath ?? args.posterPath ?? null,
			releaseDate: movie.releaseDate ?? null,
			isAnime: movie.isAnime
		};
	}

	const base = await ctx.db.get(ensured.mediaId);
	if (!base) throw new Error('Series not found.');
	const tvShow = await getFinalTV(ctx, base);
	if (tvShow.isAnime == null) {
		throw new Error('This title is still being enriched. Try again in a moment.');
	}
	return {
		mediaType: 'tv' as const,
		movieId: null,
		tvShowId: ensured.mediaId,
		tmdbId: tvShow.tmdbId ?? null,
		title: tvShow.title,
		posterPath: tvShow.posterPath ?? args.posterPath ?? null,
		releaseDate: tvShow.releaseDate ?? null,
		isAnime: tvShow.isAnime
	};
}

function sortItemsForPresentation(
	items: CollectionItemDoc[],
	layout: CollectionDoc['layout'],
	tiers: CollectionTierDoc[]
) {
	const presentItem = (item: CollectionItemDoc) => ({
		id: item._id,
		mediaType: item.mediaType,
		tmdbId: item.tmdbId,
		title: item.title,
		posterPath: item.posterPath,
		releaseDate: item.releaseDate,
		isAnime: item.isAnime,
		tierKey: item.tierKey,
		sortOrder: item.sortOrder,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt
	});

	if (layout !== 'tiered') {
		return {
			items: items.sort((left, right) => left.sortOrder - right.sortOrder).map(presentItem),
			tiers: []
		};
	}

	const grouped = new Map<string, CollectionItemDoc[]>();
	for (const item of items) {
		const key = item.tierKey ?? '';
		const bucket = grouped.get(key) ?? [];
		bucket.push(item);
		grouped.set(key, bucket);
	}
	return {
		items: [],
		tiers: tiers.map((tier) => ({
			key: tier.key,
			label: tier.label,
			sortOrder: tier.sortOrder,
			items: (grouped.get(tier.key) ?? [])
				.sort((left, right) => left.sortOrder - right.sortOrder)
				.map(presentItem)
		}))
	};
}

export const getMyCollections = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		return await buildMyCollectionSummaries(ctx, identity.subject);
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
		return await Promise.all(
			collections.map(async (collection) =>
				presentCollectionSummary(
					ctx,
					collection,
					identity?.subject ?? null,
					await getViewerRole(ctx, collection, identity?.subject ?? null)
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
		const mediaKey = await resolveCollectionMediaKey(ctx, {
			mediaType: args.mediaType,
			tmdbId: args.tmdbId
		});
		return await Promise.all(
			collectionEntries.map(async ({ collection, role }) => {
				const summary = await presentCollectionSummary(ctx, collection, identity.subject, role);
				const existingItem = mediaKey
					? await getCollectionItemByMediaKey(ctx, collection._id, mediaKey)
					: null;
				let reason: string | null = null;
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
		defaultSort: v.optional(sortOptionValidator)
	},
	handler: async (ctx, args) => {
		const { collection, role, identity } = await requireCollectionAccess(ctx, args.collectionId, {
			requireEdit: true
		});
		const patch: Partial<CollectionDoc> = {
			updatedAt: Date.now()
		};
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
