import { v } from 'convex/values';

import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';

async function requireIdentity(ctx: QueryCtx | MutationCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Unauthorized: Please login or signup to continue');
	}
	return identity;
}

async function getProfileByUserId(ctx: QueryCtx | MutationCtx, userId: string) {
	return await ctx.db
		.query('userProfiles')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.unique();
}

async function ensureTargetProfileExists(ctx: QueryCtx | MutationCtx, userId: string) {
	const profile = await getProfileByUserId(ctx, userId);
	if (!profile) {
		throw new Error('User profile not found.');
	}
	return profile;
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

export const followUser = mutation({
	args: {
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		if (args.userId === identity.subject) {
			throw new Error('You cannot follow yourself.');
		}

		await ensureTargetProfileExists(ctx, args.userId);
		const existing = await getFollowRow(ctx, identity.subject, args.userId);
		if (existing) return existing._id;

		return await ctx.db.insert('socialFollows', {
			followerUserId: identity.subject,
			followedUserId: args.userId,
			createdAt: Date.now()
		});
	}
});

export const unfollowUser = mutation({
	args: {
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		if (args.userId === identity.subject) return false;

		const existing = await getFollowRow(ctx, identity.subject, args.userId);
		if (!existing) return false;

		await ctx.db.delete(existing._id);
		return true;
	}
});

export const getRelationship = query({
	args: {
		userId: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		if (args.userId === identity.subject) {
			return {
				viewerUserId: identity.subject,
				targetUserId: args.userId,
				follows: false,
				followedBy: false,
				isFriend: false
			};
		}

		const [follows, followedBy] = await Promise.all([
			getFollowRow(ctx, identity.subject, args.userId),
			getFollowRow(ctx, args.userId, identity.subject)
		]);

		return {
			viewerUserId: identity.subject,
			targetUserId: args.userId,
			follows: follows !== null,
			followedBy: followedBy !== null,
			isFriend: follows !== null && followedBy !== null
		};
	}
});
