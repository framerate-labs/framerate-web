import type { Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { isCreatorOnlyPrivateCollection, normalizeShareAudience } from '../../utils/collections/core';
import type { CollectionDoc, MyCollectionEntry, ViewerRole } from '../../types/collectionTypes';
import { getCollaboratorRow, getFollowRow, getViewerInviteRow } from './repository';

type AuthIdentity = Awaited<ReturnType<QueryCtx['auth']['getUserIdentity']>>;

export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Unauthorized: Please login or signup to continue');
	}
	return identity;
}

export async function getViewerRole(
	ctx: QueryCtx | MutationCtx,
	collection: CollectionDoc,
	userId: string | null
): Promise<ViewerRole> {
	if (!userId) return 'none';
	if (collection.creatorId === userId) return 'creator';
	const collaborator = await getCollaboratorRow(ctx, collection._id, userId);
	return collaborator ? 'collaborator' : 'viewer';
}

export function canEditCollection(role: ViewerRole): boolean {
	return role === 'creator' || role === 'collaborator';
}

export function canChangeVisibility(role: ViewerRole): boolean {
	return role === 'creator';
}

export function canToggleComments(role: ViewerRole): boolean {
	return role === 'creator';
}

export function canInviteCollaborators(role: ViewerRole): boolean {
	return role === 'creator' || role === 'collaborator';
}

export function canRemoveCollaborator(
	role: ViewerRole,
	targetUserId: string,
	actorUserId: string
): boolean {
	if (targetUserId === actorUserId) return true;
	return role === 'creator';
}

export function canSaveCollection(collection: CollectionDoc, role: ViewerRole): boolean {
	if (role === 'creator' || role === 'collaborator') return false;
	return collection.visibility === 'public';
}

export function canCloneCollection(_collection: CollectionDoc, role: ViewerRole): boolean {
	return role !== 'none';
}

export async function viewerMatchesShareAudience(
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

export async function canViewCollection(
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

export async function requireCollectionAccess(
	ctx: QueryCtx | MutationCtx,
	collectionId: Id<'collections'>,
	options?: { requireEdit?: boolean }
): Promise<{ collection: CollectionDoc; role: ViewerRole; identity: AuthIdentity }> {
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

export async function buildMyCollectionEntries(
	ctx: QueryCtx,
	userId: string
): Promise<MyCollectionEntry[]> {
	const [created, collaboratorRows, viewerInviteRows] = await Promise.all([
		ctx.db
			.query('collections')
			.withIndex('by_creatorId_updatedAt', (q) => q.eq('creatorId', userId))
			.order('desc')
			.collect(),
		ctx.db
			.query('collectionCollaborators')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.collect(),
		ctx.db
			.query('collectionViewerInvites')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.collect()
	]);
	const [collaboratorCollections, viewerInviteCollections] = await Promise.all([
		Promise.all(collaboratorRows.map(async (row) => ctx.db.get(row.collectionId))),
		Promise.all(viewerInviteRows.map(async (row) => ctx.db.get(row.collectionId)))
	]);

	const merged = new Map<Id<'collections'>, MyCollectionEntry>();
	for (const collection of created) {
		merged.set(collection._id, { collection, role: 'creator' });
	}
	for (const collection of collaboratorCollections) {
		if (collection && !merged.has(collection._id)) {
			merged.set(collection._id, { collection, role: 'collaborator' });
		}
	}
	for (const collection of viewerInviteCollections) {
		if (collection && !merged.has(collection._id)) {
			merged.set(collection._id, { collection, role: 'viewer' });
		}
	}

	return Array.from(merged.values()).sort(
		(left, right) => right.collection.updatedAt - left.collection.updatedAt
	);
}

export async function buildMyCollectionDocuments(ctx: QueryCtx, userId: string) {
	return (await buildMyCollectionEntries(ctx, userId)).map(({ collection }) => collection);
}
