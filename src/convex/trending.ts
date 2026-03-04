import type { Filter, TimeWindow } from './types/tmdb/trendingTypes';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { internalAction, internalMutation, query } from './_generated/server';
import { fetchTrendingFromTMDB } from './services/trendingService';
import { buildMediaCardSummaries } from './utils/mediaCardPresentation';
import { upsertByExisting } from './utils/upsert';

// Argument validators (reusable)
const filterValidator = v.union(
	v.literal('all'),
	v.literal('movie'),
	v.literal('tv'),
	v.literal('person')
);

const timeWindowValidator = v.union(v.literal('day'), v.literal('week'));
const normalizedTrendingItemValidator = v.object({
	id: v.number(),
	mediaType: v.union(v.literal('movie'), v.literal('tv'), v.literal('person')),
	title: v.string(),
	posterPath: v.union(v.string(), v.null()),
	profilePath: v.optional(v.union(v.string(), v.null()))
});

/**
 * Query: Get trending media from cache.
 *
 * This is the primary endpoint for clients. It's:
 * - Instant (reads from Convex DB, no external API call)
 * - Reactive (auto-updates when cache is refreshed)
 * - Cached by Convex (deduped across concurrent requests)
 *
 * Returns null if cache is empty (call refreshTrending action first).
 */
export const get = query({
	args: {
		filter: filterValidator,
		timeWindow: timeWindowValidator
	},
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('trendingCache')
			.withIndex('by_filter_timeWindow', (q) =>
				q.eq('filter', args.filter).eq('timeWindow', args.timeWindow)
			)
			.unique();

		if (!cached) return null;

		return buildMediaCardSummaries(
			ctx,
			cached.items.map((item) => ({
				id: item.id,
				mediaType: item.mediaType,
				title: item.title,
				// Person rows use profilePath in TMDB payloads, so fall back to it.
				posterPath:
					item.mediaType === 'person' ? (item.posterPath ?? item.profilePath ?? null) : item.posterPath
			}))
		);
	}
});

/**
 * Internal Mutation: Store trending data in cache.
 *
 * Called by the refresh action after fetching from TMDB.
 * Uses upsert pattern - replaces existing cache entry or creates new one.
 */
export const storeTrendingCache = internalMutation({
	args: {
		filter: filterValidator,
		timeWindow: timeWindowValidator,
		items: v.array(normalizedTrendingItemValidator),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		await upsertByExisting({
			findExisting: () =>
				ctx.db
					.query('trendingCache')
					.withIndex('by_filter_timeWindow', (q) =>
						q.eq('filter', args.filter).eq('timeWindow', args.timeWindow)
					)
					.unique(),
			onInsert: async () => {
				await ctx.db.insert('trendingCache', {
					filter: args.filter,
					timeWindow: args.timeWindow,
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

/**
 * Internal Action: Refresh trending cache from TMDB.
 *
 * Called by cron job or manually when cache needs refresh.
 * Makes external HTTP call to TMDB, then stores result via mutation.
 */
export const refreshTrending = internalAction({
	args: {
		filter: filterValidator,
		timeWindow: timeWindowValidator
	},
	handler: async (ctx, args) => {
		const items = await fetchTrendingFromTMDB(args.filter as Filter, args.timeWindow as TimeWindow);
		const cacheItems = items.map((item) =>
			item.mediaType === 'person'
				? {
						id: item.id,
						mediaType: item.mediaType,
						title: item.title,
						posterPath: item.posterPath,
						profilePath: item.profilePath ?? null
					}
				: {
						id: item.id,
						mediaType: item.mediaType,
						title: item.title,
						posterPath: item.posterPath
					}
		);

		// Store in cache via mutation
		await ctx.runMutation(internal.trending.storeTrendingCache, {
			filter: args.filter as Filter,
			timeWindow: args.timeWindow as TimeWindow,
			items: cacheItems,
			fetchedAt: Date.now()
		});

		return { refreshed: true, itemCount: items.length };
	}
});

/**
 * Internal Action: Refresh all trending combinations.
 *
 * Called by cron job to keep all cache entries fresh.
 * Refreshes all 8 combinations (4 filters × 2 time windows).
 */
export const refreshAllTrending = internalAction({
	args: {},
	handler: async (ctx) => {
		const filters: Filter[] = ['all', 'movie', 'tv', 'person'];
		const timeWindows: TimeWindow[] = ['day', 'week'];

		// Run all refreshes concurrently for efficiency
		const refreshPromises = filters.flatMap((filter) =>
			timeWindows.map((timeWindow) =>
				ctx.runAction(internal.trending.refreshTrending, { filter, timeWindow })
			)
		);

		await Promise.all(refreshPromises);

		return { refreshed: true, combinations: filters.length * timeWindows.length };
	}
});
