import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalMutation, internalQuery } from './_generated/server';
import { fetchSearchFromTMDB, type NormalizedSearchItem } from './services/searchService';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_RETENTION_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 25;
const RATE_LIMIT_RETENTION_MS = 10 * 60 * 1000;

function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const getCachedResults = internalQuery({
	args: {
		queryKey: v.string(),
		limit: v.number(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('searchCache')
			.withIndex('by_queryKey_limit', (q) => q.eq('queryKey', args.queryKey).eq('limit', args.limit))
			.unique();

		if (!cached) return null;
		if (args.now - cached.fetchedAt > CACHE_TTL_MS) return null;

		return cached;
	}
});

export const storeCachedResults = internalMutation({
	args: {
		queryKey: v.string(),
		limit: v.number(),
		items: v.array(
			v.object({
				id: v.number(),
				mediaType: v.union(v.literal('movie'), v.literal('tv')),
				title: v.string(),
				originalTitle: v.string(),
				overview: v.optional(v.string()),
				posterPath: v.union(v.string(), v.null()),
				backdropPath: v.union(v.string(), v.null()),
				popularity: v.number(),
				releaseDate: v.union(v.string(), v.null()),
				voteAverage: v.union(v.number(), v.null()),
				voteCount: v.union(v.number(), v.null()),
				adult: v.boolean()
			})
		),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('searchCache')
			.withIndex('by_queryKey_limit', (q) => q.eq('queryKey', args.queryKey).eq('limit', args.limit))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				items: args.items,
				fetchedAt: args.fetchedAt
			});
			return;
		}

		await ctx.db.insert('searchCache', {
			queryKey: args.queryKey,
			limit: args.limit,
			items: args.items,
			fetchedAt: args.fetchedAt
		});
	}
});




export const cleanupSearchCache = internalMutation({
	args: {
		now: v.number()
	},
	handler: async (ctx, args) => {
		const staleBefore = args.now - CACHE_RETENTION_MS;
		const staleRows = await ctx.db
			.query('searchCache')
			.withIndex('by_fetchedAt', (q) => q.lt('fetchedAt', staleBefore))
			.take(100);

		for (const row of staleRows) {
			await ctx.db.delete(row._id);
		}
	}
});

export const cleanupSearchRateLimit = internalMutation({
	args: {
		now: v.number()
	},
	handler: async (ctx, args) => {
		const staleBefore = args.now - RATE_LIMIT_RETENTION_MS;
		const staleRows = await ctx.db
			.query('searchRateLimit')
			.withIndex('by_bucketStart', (q) => q.lt('bucketStart', staleBefore))
			.take(200);

		for (const row of staleRows) {
			await ctx.db.delete(row._id);
		}
	}
});

export const cleanupSearchArtifacts = internalAction({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		await ctx.runMutation(internal.search.cleanupSearchCache, { now });
		await ctx.runMutation(internal.search.cleanupSearchRateLimit, { now });
		return { cleanedAt: now };
	}
});
export const enforceRateLimit = internalMutation({
	args: {
		userId: v.string(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const bucketStart = Math.floor(args.now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
		const existing = await ctx.db
			.query('searchRateLimit')
			.withIndex('by_userId_bucketStart', (q) =>
				q.eq('userId', args.userId).eq('bucketStart', bucketStart)
			)
			.unique();

		if (existing) {
			if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
				throw new Error('Rate limit exceeded. Please wait before searching again.');
			}

			await ctx.db.patch(existing._id, {
				count: existing.count + 1,
				updatedAt: args.now
			});
		} else {
			await ctx.db.insert('searchRateLimit', {
				userId: args.userId,
				bucketStart,
				count: 1,
				updatedAt: args.now
			});
		}

	}
});

/**
 * Action: Search media (movies + TV only) via TMDB.
 *
 * - Requires authentication to reduce anonymous abuse
 * - Enforces per-user request rate limits
 * - Uses short-lived server cache to reduce TMDB pressure
 */
export const searchMedia = action({
	args: {
		query: v.string(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args): Promise<NormalizedSearchItem[]> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}

		const normalizedQuery = normalizeQuery(args.query);
		if (normalizedQuery.length === 0) return [];
		if (normalizedQuery.length < MIN_QUERY_LENGTH) return [];
		if (normalizedQuery.length > MAX_QUERY_LENGTH) {
			throw new Error(`Query too long (max ${MAX_QUERY_LENGTH} characters)`);
		}

		const safeLimit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
		const now = Date.now();

		const cached = await ctx.runQuery(internal.search.getCachedResults, {
			queryKey: normalizedQuery,
			limit: safeLimit,
			now
		});
		if (cached) {
			return cached.items;
		}

		await ctx.runMutation(internal.search.enforceRateLimit, {
			userId: identity.subject,
			now
		});

		const items = await fetchSearchFromTMDB(normalizedQuery, safeLimit);

		await ctx.runMutation(internal.search.storeCachedResults, {
			queryKey: normalizedQuery,
			limit: safeLimit,
			items,
			fetchedAt: now
		});

		return items;
	}
});
