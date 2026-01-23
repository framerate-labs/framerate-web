import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// Validator for trending media items (normalized to consistent shape)
const trendingMediaValidator = v.object({
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
	// Person-specific fields
	profilePath: v.optional(v.union(v.string(), v.null())),
	knownForDepartment: v.optional(v.union(v.string(), v.null()))
});

export default defineSchema({
	appConfig: defineTable({
		heroImage: v.object({
			storageId: v.id('_storage'),
			title: v.string(),
			blurHash: v.optional(v.string())
		}),

		featureFlags: v.optional(v.record(v.string(), v.boolean()))
	}),

	// Cached trending data - one document per filter+timeWindow combination
	trendingCache: defineTable({
		filter: v.union(
			v.literal('all'),
			v.literal('movie'),
			v.literal('tv'),
			v.literal('person')
		),
		timeWindow: v.union(v.literal('day'), v.literal('week')),
		items: v.array(trendingMediaValidator),
		fetchedAt: v.number() // timestamp for cache freshness
	}).index('by_filter_timeWindow', ['filter', 'timeWindow'])
});
