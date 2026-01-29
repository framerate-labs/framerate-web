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
		filter: v.union(v.literal('all'), v.literal('movie'), v.literal('tv'), v.literal('person')),
		timeWindow: v.union(v.literal('day'), v.literal('week')),
		items: v.array(trendingMediaValidator),
		fetchedAt: v.number() // timestamp for cache freshness
	}).index('by_filter_timeWindow', ['filter', 'timeWindow']),

	// Movies table - stores movie metadata (data source hub)
	// Supports multiple data sources (TMDB, Trakt, IMDB, etc.)
	// A movie must have at least one source ID, but can have multiple
	movies: defineTable({
		// External source IDs
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		// Media metadata
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		slug: v.union(v.string(), v.null())
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId']),

	// TV Shows table - stores TV series metadata (data source hub)
	// Supports multiple data sources (TMDB, Trakt, IMDB, etc.)
	// A show must have at least one source ID, but can have multiple
	tvShows: defineTable({
		// External source IDs
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		// Media metadata
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		slug: v.union(v.string(), v.null())
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId']),

	// Movie Reviews - user ratings and reviews for movies
	// Uses internal Convex IDs for proper normalization and multi-source support
	movieReviews: defineTable({
		userId: v.string(),
		movieId: v.id('movies'), // Internal Convex movie ID
		rating: v.string(),
		liked: v.boolean(),
		watched: v.boolean(),
		review: v.union(v.string(), v.null()), // Optional text review
		mediaType: v.literal('movie'),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId', ['userId']) // For fetching all user's reviews
		.index('by_movieId', ['movieId']) // For computing average ratings
		.index('by_userId_movieId', ['userId', 'movieId']), // For fetching specific review (most common query)

	// TV Reviews - user ratings and reviews for TV shows
	// Uses internal Convex IDs for proper normalization and multi-source support
	tvReviews: defineTable({
		userId: v.string(),
		tvShowId: v.id('tvShows'), // Internal Convex TV show ID
		rating: v.string(),
		liked: v.boolean(),
		watched: v.boolean(),
		review: v.union(v.string(), v.null()), // Optional text review
		mediaType: v.literal('tv'),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId', ['userId']) // For fetching all user's reviews
		.index('by_tvShowId', ['tvShowId']) // For computing average ratings
		.index('by_userId_tvShowId', ['userId', 'tvShowId']) // For fetching specific review (most common query)
});
