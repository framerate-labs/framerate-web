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

// User session management for secure token refresh
// Refresh tokens are stored server-side for security
const userSessionValidator = v.object({
	userId: v.string(), // WorkOS user ID (identity.subject)
	refreshToken: v.string(), // WorkOS refresh token
	sessionId: v.string(), // WorkOS session ID (from JWT 'sid' claim)
	deviceSecretHash: v.string(), // SHA-256 of device-bound secret
	expiresAt: v.optional(v.number()), // When refresh token expires (if known)
	createdAt: v.number(),
	updatedAt: v.number(),
	// Track refresh token rotation
	previousRefreshToken: v.optional(v.string()), // For detecting token reuse attacks
	rotatedAt: v.optional(v.number())
});

const detailCreatorCreditValidator = v.object({
	type: v.union(v.literal('person'), v.literal('company')),
	tmdbId: v.union(v.number(), v.null()),
	name: v.string(),
	role: v.union(v.string(), v.null())
});

export default defineSchema({
	// Single-row app-wide configuration (hero artwork + feature flags).
	appConfig: defineTable({
		heroImage: v.object({
			storageId: v.id('_storage'),
			title: v.string(),
			blurHash: v.optional(v.string())
		}),
		featureFlags: v.optional(v.record(v.string(), v.boolean()))
	}),

	// Cached TMDB trending results keyed by filter + time window.
	trendingCache: defineTable({
		filter: v.union(v.literal('all'), v.literal('movie'), v.literal('tv'), v.literal('person')),
		timeWindow: v.union(v.literal('day'), v.literal('week')),
		items: v.array(trendingMediaValidator),
		fetchedAt: v.number()
	}).index('by_filter_timeWindow', ['filter', 'timeWindow']),

	// Short-lived TMDB search result cache keyed by normalized query + limit.
	searchCache: defineTable({
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
	})
		.index('by_queryKey_limit', ['queryKey', 'limit'])
		.index('by_fetchedAt', ['fetchedAt']),

	// Per-user search rate-limit buckets.
	searchRateLimit: defineTable({
		userId: v.string(),
		bucketStart: v.number(),
		count: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId_bucketStart', ['userId', 'bucketStart'])
		.index('by_bucketStart', ['bucketStart']),

	// Transient refresh leases used to dedupe stale detail refresh jobs.
	detailRefreshLeases: defineTable({
		refreshKey: v.string(),
		mediaType: v.union(v.literal('movie'), v.literal('tv')),
		source: v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb')),
		externalId: v.number(),
		owner: v.string(),
		leasedAt: v.number(),
		leaseExpiresAt: v.number()
	})
		.index('by_refreshKey', ['refreshKey'])
		.index('by_leaseExpiresAt', ['leaseExpiresAt']),

	// Canonical movie records (multi-source IDs + DB-first detail snapshot).
	movies: defineTable({
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		isAnime: v.optional(v.boolean()),
		director: v.optional(v.union(v.string(), v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		runtime: v.optional(v.union(v.number(), v.null())),
		detailSchemaVersion: v.optional(v.number()),
		detailFetchedAt: v.optional(v.union(v.number(), v.null())),
		nextRefreshAt: v.optional(v.number()),
		refreshErrorCount: v.optional(v.number()),
		lastRefreshErrorAt: v.union(v.number(), v.null())
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId'])
		.index('by_nextRefreshAt', ['nextRefreshAt']),

	// Canonical TV records (multi-source IDs + DB-first detail snapshot).
	tvShows: defineTable({
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		isAnime: v.optional(v.boolean()),
		creator: v.optional(v.union(v.string(), v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		numberOfSeasons: v.optional(v.union(v.number(), v.null())),
		lastAirDate: v.optional(v.union(v.string(), v.null())),
		lastEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		nextEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		detailSchemaVersion: v.optional(v.number()),
		detailFetchedAt: v.optional(v.union(v.number(), v.null())),
		nextRefreshAt: v.optional(v.number()),
		refreshErrorCount: v.optional(v.number()),
		lastRefreshErrorAt: v.union(v.number(), v.null())
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId'])
		.index('by_nextRefreshAt', ['nextRefreshAt']),

	// Minimal person registry used by lazy person graph sync.
	people: defineTable({
		tmdbId: v.number(),
		name: v.string(),
		profilePath: v.union(v.string(), v.null())
	}).index('by_tmdbId', ['tmdbId']),

	// Minimal company/studio registry used by lazy company graph sync.
	companies: defineTable({
		tmdbId: v.number(),
		name: v.string(),
		logoPath: v.union(v.string(), v.null())
	}).index('by_tmdbId', ['tmdbId']),

	// Person-to-movie graph links for entity detail filtering and watched/in-library checks.
	movieCredits: defineTable({
		movieId: v.id('movies'),
		personId: v.id('people'),
		personTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_personTmdbId', ['personTmdbId']),

	// Person-to-TV graph links for entity detail filtering and watched/in-library checks.
	tvCredits: defineTable({
		tvShowId: v.id('tvShows'),
		personId: v.id('people'),
		personTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_personTmdbId', ['personTmdbId']),

	// Company-to-movie graph links for entity detail filtering and watched/in-library checks.
	movieCompanies: defineTable({
		movieId: v.id('movies'),
		companyId: v.id('companies'),
		companyTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_companyTmdbId', ['companyTmdbId']),

	// Company-to-TV graph links for entity detail filtering and watched/in-library checks.
	tvCompanies: defineTable({
		tvShowId: v.id('tvShows'),
		companyId: v.id('companies'),
		companyTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_companyTmdbId', ['companyTmdbId']),

	// User movie reviews/ratings; primary per-user library source for movies.
	movieReviews: defineTable({
		userId: v.string(),
		movieId: v.id('movies'),
		rating: v.string(),
		liked: v.boolean(),
		watched: v.boolean(),
		review: v.union(v.string(), v.null()),
		mediaType: v.literal('movie'),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_movieId', ['movieId'])
		.index('by_userId_movieId', ['userId', 'movieId']),

	// User TV reviews/ratings; primary per-user library source for TV.
	tvReviews: defineTable({
		userId: v.string(),
		tvShowId: v.id('tvShows'),
		rating: v.string(),
		liked: v.boolean(),
		watched: v.boolean(),
		review: v.union(v.string(), v.null()),
		mediaType: v.literal('tv'),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_tvShowId', ['tvShowId'])
		.index('by_userId_tvShowId', ['userId', 'tvShowId']),

	// Secure server-side WorkOS session/refresh-token state.
	userSessions: defineTable(userSessionValidator)
		.index('by_userId', ['userId'])
		.index('by_sessionId', ['sessionId'])
});
