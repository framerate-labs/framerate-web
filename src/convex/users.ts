import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

import { v } from 'convex/values';

import { mutation, query } from './_generated/server';
import {
	normalizeDisplayNameForSearch,
	normalizeDisplayNameForStorage,
	normalizeOptionalString,
	normalizeUsernameForStorage
} from './utils/profileValidation';

const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_CANDIDATE_LIMIT = MAX_SEARCH_LIMIT * 2;
const DEFAULT_DISPLAY_NAME = 'Unknown User';
const SEARCH_RANGE_SUFFIX = '\uffff';

type UserProfileDoc = Doc<'userProfiles'>;
type ProfileFields = {
	email: UserProfileDoc['email'];
	emailNormalized: UserProfileDoc['emailNormalized'];
	username: string | null;
	displayName: UserProfileDoc['displayName'];
	searchName: UserProfileDoc['searchName'];
	profilePictureUrl: UserProfileDoc['profilePictureUrl'];
};
type PublicProfile = Pick<
	UserProfileDoc,
	'userId' | 'displayName' | 'email' | 'profilePictureUrl'
> & {
	username: string | null;
};
type AuthedCtx = QueryCtx | MutationCtx;

function buildProfileFields(args: {
	email?: string | null;
	displayName: string;
	username?: string | null;
	profilePictureUrl?: string | null;
}): ProfileFields {
	const email = normalizeOptionalString(args.email);
	const displayName = normalizeDisplayNameForStorage(args.displayName);
	const username = normalizeUsernameForStorage(args.username);

	return {
		email,
		emailNormalized: email?.toLowerCase() ?? null,
		username,
		displayName,
		searchName: normalizeDisplayNameForSearch(displayName),
		profilePictureUrl: normalizeOptionalString(args.profilePictureUrl)
	};
}

function hasOwnField<T extends object>(value: T, key: keyof T): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function hasProfileFieldChanges(profile: UserProfileDoc, nextFields: ProfileFields): boolean {
	return (
		profile.email !== nextFields.email ||
		profile.emailNormalized !== nextFields.emailNormalized ||
		(profile.username ?? null) !== nextFields.username ||
		profile.displayName !== nextFields.displayName ||
		profile.searchName !== nextFields.searchName ||
		profile.profilePictureUrl !== nextFields.profilePictureUrl
	);
}

async function requireIdentity(ctx: AuthedCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Unauthorized: Please login or signup to continue');
	}
	return identity;
}

async function getProfileByUserId(ctx: AuthedCtx, userId: string) {
	return ctx.db
		.query('userProfiles')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.unique();
}

async function getProfileByUsername(ctx: AuthedCtx, username: string) {
	return ctx.db
		.query('userProfiles')
		.withIndex('by_username', (q) => q.eq('username', username))
		.unique();
}

async function ensureUsernameAvailable(
	ctx: AuthedCtx,
	username: string | null,
	currentUserId: string
) {
	if (!username) return;
	const existing = await getProfileByUsername(ctx, username);
	if (existing && existing.userId !== currentUserId) {
		throw new Error('That username is already taken.');
	}
}

async function saveProfile(
	ctx: MutationCtx,
	userId: string,
	existing: UserProfileDoc | null,
	profileFields: ProfileFields,
	now: number
) {
	if (!existing) {
		await ctx.db.insert('userProfiles', {
			userId,
			...profileFields,
			createdAt: now,
			updatedAt: now
		});
		return;
	}

	if (!hasProfileFieldChanges(existing, profileFields)) {
		return;
	}

	await ctx.db.patch(existing._id, {
		...profileFields,
		updatedAt: now
	});
}

function presentProfile(
	profile: Pick<
		UserProfileDoc,
		'userId' | 'displayName' | 'username' | 'email' | 'profilePictureUrl'
	>
): PublicProfile {
	return {
		userId: profile.userId,
		displayName: profile.displayName,
		username: profile.username ?? null,
		email: profile.email,
		profilePictureUrl: profile.profilePictureUrl
	};
}

export const syncCurrentProfile = mutation({
	args: {
		email: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const now = Date.now();
		const existing = await getProfileByUserId(ctx, identity.subject);
		const profileFields = buildProfileFields({
			email: hasOwnField(args, 'email') ? args.email : (existing?.email ?? null),
			displayName: existing?.displayName ?? DEFAULT_DISPLAY_NAME,
			username: existing?.username ?? null,
			profilePictureUrl: existing?.profilePictureUrl ?? null
		});

		await saveProfile(ctx, identity.subject, existing, profileFields, now);

		return { synced: true, userId: identity.subject };
	}
});

export const getCurrentProfile = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		const profile = await getProfileByUserId(ctx, identity.subject);
		return profile ? presentProfile(profile) : null;
	}
});

export const checkUsernameAvailability = query({
	args: {
		username: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);

		try {
			const username = normalizeUsernameForStorage(args.username);
			if (!username) {
				return {
					username: null,
					isAvailable: false,
					message: 'Username is required.'
				};
			}

			const existing = await getProfileByUsername(ctx, username);
			const isAvailable = existing === null || existing.userId === identity.subject;
			return {
				username,
				isAvailable,
				message: isAvailable ? 'Username is available.' : 'That username is already taken.'
			};
		} catch (error) {
			return {
				username: null,
				isAvailable: false,
				message: error instanceof Error ? error.message : 'Invalid username.'
			};
		}
	}
});

export const updateCurrentProfile = mutation({
	args: {
		displayName: v.string(),
		username: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const existing = await getProfileByUserId(ctx, identity.subject);
		const now = Date.now();
		const profileFields = buildProfileFields({
			email: existing?.email ?? null,
			displayName: args.displayName,
			username: hasOwnField(args, 'username') ? args.username : (existing?.username ?? null),
			profilePictureUrl: existing?.profilePictureUrl ?? null
		});
		await ensureUsernameAvailable(ctx, profileFields.username, identity.subject);

		await saveProfile(ctx, identity.subject, existing, profileFields, now);

		return presentProfile({
			userId: identity.subject,
			...profileFields
		});
	}
});

export const searchProfiles = query({
	args: {
		query: v.string(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const normalizedQuery = normalizeDisplayNameForSearch(args.query);
		if (normalizedQuery.length < 2) return [];

		const limit = Math.max(1, Math.min(args.limit ?? 8, MAX_SEARCH_LIMIT));
		const candidateLimit = Math.min(limit * 2, MAX_SEARCH_CANDIDATE_LIMIT);
		const [usernameRows, displayNameRows] = await Promise.all([
			ctx.db
				.query('userProfiles')
				.withIndex('by_username', (q) =>
					q
						.gte('username', normalizedQuery)
						.lt('username', `${normalizedQuery}${SEARCH_RANGE_SUFFIX}`)
				)
				.take(candidateLimit),
			ctx.db
				.query('userProfiles')
				.withIndex('by_searchName', (q) =>
					q
						.gte('searchName', normalizedQuery)
						.lt('searchName', `${normalizedQuery}${SEARCH_RANGE_SUFFIX}`)
				)
				.take(candidateLimit)
		]);

		const merged = new Map<UserProfileDoc['userId'], UserProfileDoc>();
		for (const row of usernameRows) {
			if (row.userId !== identity.subject) {
				merged.set(row.userId, row);
			}
		}
		for (const row of displayNameRows) {
			if (row.userId !== identity.subject && !merged.has(row.userId)) {
				merged.set(row.userId, row);
			}
		}

		return Array.from(merged.values()).slice(0, limit).map(presentProfile);
	}
});
