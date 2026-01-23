import { v } from 'convex/values';
import { query, internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import {
	fetchTrendingFromTMDB,
	type Filter,
	type TimeWindow,
	type NormalizedTrendingItem
} from './services/trendingService';

// Argument validators (reusable)
const filterValidator = v.union(
	v.literal('all'),
	v.literal('movie'),
	v.literal('tv'),
	v.literal('person')
);

const timeWindowValidator = v.union(v.literal('day'), v.literal('week'));

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

		if (!cached) {
			return null;
		}

		return {
			items: cached.items,
			fetchedAt: cached.fetchedAt
		};
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
		items: v.array(
			v.object({
				id: v.number(),
				mediaType: v.union(v.literal('movie'), v.literal('tv'), v.literal('person')),
				title: v.string(),
				originalTitle: v.string(),
				overview: v.optional(v.string()),
				posterPath: v.union(v.string(), v.null()),
				backdropPath: v.union(v.string(), v.null()),
				popularity: v.number(),
				voteAverage: v.optional(v.number()),
				voteCount: v.optional(v.number()),
				releaseDate: v.optional(v.string()),
				genreIds: v.optional(v.array(v.number())),
				adult: v.boolean(),
				profilePath: v.optional(v.union(v.string(), v.null())),
				knownForDepartment: v.optional(v.union(v.string(), v.null()))
			})
		),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		// Check for existing cache entry
		const existing = await ctx.db
			.query('trendingCache')
			.withIndex('by_filter_timeWindow', (q) =>
				q.eq('filter', args.filter).eq('timeWindow', args.timeWindow)
			)
			.unique();

		if (existing) {
			// Update existing cache
			await ctx.db.patch(existing._id, {
				items: args.items,
				fetchedAt: args.fetchedAt
			});
		} else {
			// Create new cache entry
			await ctx.db.insert('trendingCache', {
				filter: args.filter,
				timeWindow: args.timeWindow,
				items: args.items,
				fetchedAt: args.fetchedAt
			});
		}
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
		const items = await fetchTrendingFromTMDB(
			args.filter as Filter,
			args.timeWindow as TimeWindow
		);

		// Store in cache via mutation
		await ctx.runMutation(internal.trending.storeTrendingCache, {
			filter: args.filter as Filter,
			timeWindow: args.timeWindow as TimeWindow,
			items: items as NormalizedTrendingItem[],
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
