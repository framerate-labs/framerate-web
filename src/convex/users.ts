import { v } from 'convex/values';

import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';

const MAX_SEARCH_LIMIT = 20;
const DEFAULT_DISPLAY_NAME = 'Unknown User';

function normalizeOptionalString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function normalizeDisplayName(value: string | null | undefined): string {
	const trimmed = value?.trim().replace(/\s+/g, ' ') ?? '';
	return trimmed || DEFAULT_DISPLAY_NAME;
}

function normalizeSearchName(value: string): string {
	return value.trim().toLowerCase();
}

function buildProfileFields(args: {
	email?: string | null;
	displayName?: string | null;
	profilePictureUrl?: string | null;
}) {
	const email = normalizeOptionalString(args.email);
	const displayName = normalizeDisplayName(args.displayName);

	return {
		email,
		emailNormalized: email?.toLowerCase() ?? null,
		displayName,
		searchName: normalizeSearchName(displayName),
		profilePictureUrl: normalizeOptionalString(args.profilePictureUrl)
	};
}

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

function presentProfile(profile: {
	userId: string;
	displayName: string;
	email: string | null;
	profilePictureUrl: string | null;
}) {
	return {
		userId: profile.userId,
		displayName: profile.displayName,
		email: profile.email,
		profilePictureUrl: profile.profilePictureUrl
	};
}

export const syncCurrentProfile = mutation({
	args: {
		email: v.optional(v.union(v.string(), v.null())),
		displayName: v.optional(v.union(v.string(), v.null())),
		profilePictureUrl: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const now = Date.now();
		const profileFields = buildProfileFields(args);
		const existing = await getProfileByUserId(ctx, identity.subject);

		if (existing) {
			await ctx.db.patch(existing._id, {
				...profileFields,
				updatedAt: now
			});
		} else {
			await ctx.db.insert('userProfiles', {
				userId: identity.subject,
				...profileFields,
				createdAt: now,
				updatedAt: now
			});
		}

		return { synced: true, userId: identity.subject };
	}
});

export const getCurrentProfile = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		return await getProfileByUserId(ctx, identity.subject);
	}
});

export const searchProfiles = query({
	args: {
		query: v.string(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const normalizedQuery = normalizeSearchName(args.query);
		if (normalizedQuery.length < 2) return [];

		const limit = Math.max(1, Math.min(args.limit ?? 8, MAX_SEARCH_LIMIT));
		const rows = await ctx.db
			.query('userProfiles')
			.withIndex('by_searchName', (q) =>
				q.gte('searchName', normalizedQuery).lt('searchName', `${normalizedQuery}\uffff`)
			)
			.take(limit + 1);

		return rows
			.filter((profile) => profile.userId !== identity.subject)
			.slice(0, limit)
			.map(presentProfile);
	}
});
