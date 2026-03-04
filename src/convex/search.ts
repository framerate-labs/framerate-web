import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { fetchSearchFromTMDB } from './services/searchService';
import { buildMediaCardSummaries } from './utils/mediaCardPresentation';
import { upsertByExisting } from './utils/upsert';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_RETENTION_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 25;
const RATE_LIMIT_RETENTION_MS = 10 * 60 * 1000;
const normalizedSearchItemValidator = v.object({
	id: v.number(),
	mediaType: v.union(v.literal('movie'), v.literal('tv')),
	title: v.string(),
	posterPath: v.union(v.string(), v.null())
});

function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function deleteRows<TRow extends { _id: string }>(
	rows: TRow[],
	deleteById: (id: TRow['_id']) => Promise<void>
): Promise<void> {
	for (const row of rows) {
		await deleteById(row._id);
	}
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
			.withIndex('by_queryKey_limit', (q) =>
				q.eq('queryKey', args.queryKey).eq('limit', args.limit)
			)
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
		items: v.array(normalizedSearchItemValidator),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		await upsertByExisting({
			findExisting: () =>
				ctx.db
					.query('searchCache')
					.withIndex('by_queryKey_limit', (q) =>
						q.eq('queryKey', args.queryKey).eq('limit', args.limit)
					)
					.unique(),
			onInsert: async () => {
				await ctx.db.insert('searchCache', {
					queryKey: args.queryKey,
					limit: args.limit,
					items: args.items,
					fetchedAt: args.fetchedAt
				});
			},
			onUpdate: (existing) =>
				ctx.db.patch(existing._id, {
					items: args.items,
					fetchedAt: args.fetchedAt
				})
		});
	}
});

export const presentSearchResults = internalQuery({
	args: {
		items: v.array(normalizedSearchItemValidator)
	},
	handler: async (ctx, args) => {
		return buildMediaCardSummaries(
			ctx,
			args.items.map((item) => ({
				id: item.id,
				mediaType: item.mediaType,
				title: item.title,
				posterPath: item.posterPath
			}))
		);
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
		await deleteRows(staleRows, (id) => ctx.db.delete(id));
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
		await deleteRows(staleRows, (id) => ctx.db.delete(id));
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
	handler: async (ctx, args) => {
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
			return await ctx.runQuery(internal.search.presentSearchResults, { items: cached.items });
		}

		await ctx.runMutation(internal.search.enforceRateLimit, {
			userId: identity.subject,
			now
		});

		const items = await fetchSearchFromTMDB(normalizedQuery, safeLimit);
		const cacheItems = items.map((item) => ({
			id: item.id,
			mediaType: item.mediaType,
			title: item.title,
			posterPath: item.posterPath
		}));

		await ctx.runMutation(internal.search.storeCachedResults, {
			queryKey: normalizedQuery,
			limit: safeLimit,
			items: cacheItems,
			fetchedAt: now
		});

		return await ctx.runQuery(internal.search.presentSearchResults, { items: cacheItems });
	}
});
