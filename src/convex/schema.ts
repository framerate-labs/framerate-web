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
	role: v.union(v.string(), v.null()),
	source: v.optional(v.union(v.literal('tmdb'), v.literal('anilist'))),
	sourceId: v.optional(v.union(v.number(), v.null())),
	matchMethod: v.optional(
		v.union(
			v.literal('exact'),
			v.literal('normalized'),
			v.literal('fuzzy'),
			v.literal('manual'),
			v.null()
		)
	),
	matchConfidence: v.optional(v.union(v.number(), v.null()))
});

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const detailSourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const detailRefreshStateValidator = v.union(
	v.literal('idle'),
	v.literal('queued'),
	v.literal('running'),
	v.literal('retry'),
	v.literal('error')
);
const storedEpisodeSummaryValidator = v.object({
	airDate: v.union(v.string(), v.null()),
	seasonNumber: v.number(),
	episodeNumber: v.number()
});

export default defineSchema({
	// =====================================================================
	// Single-row app-wide configuration (hero artwork + feature flags).
	// =====================================================================
	appConfig: defineTable({
		heroImage: v.object({
			storageId: v.id('_storage'),
			title: v.string(),
			blurHash: v.optional(v.string())
		}),
		featureFlags: v.optional(v.record(v.string(), v.boolean()))
	}),

	// =====================================================================
	// Cached TMDB trending results keyed by filter + time window.
	// =====================================================================
	trendingCache: defineTable({
		filter: v.union(v.literal('all'), v.literal('movie'), v.literal('tv'), v.literal('person')),
		timeWindow: v.union(v.literal('day'), v.literal('week')),
		items: v.array(trendingMediaValidator),
		fetchedAt: v.number()
	}).index('by_filter_timeWindow', ['filter', 'timeWindow']),

	// =====================================================================
	// Short-lived TMDB search result cache keyed by normalized query + limit.
	// =====================================================================
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

	// =====================================================================
	// Per-user search rate-limit buckets.
	// =====================================================================
	searchRateLimit: defineTable({
		userId: v.string(),
		bucketStart: v.number(),
		count: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId_bucketStart', ['userId', 'bucketStart'])
		.index('by_bucketStart', ['bucketStart']),

	// =====================================================================
	// Transient refresh leases used to dedupe stale detail refresh jobs.
	// =====================================================================
	detailRefreshLeases: defineTable({
		refreshKey: v.string(),
		mediaType: mediaTypeValidator,
		source: detailSourceValidator,
		externalId: v.number(),
		owner: v.string(),
		leasedAt: v.number(),
		leaseExpiresAt: v.number()
	})
		.index('by_refreshKey', ['refreshKey'])
		.index('by_leaseExpiresAt', ['leaseExpiresAt']),

	// =====================================================================
	// Persistent details refresh queue/state used by bounded background workers.
	// One row per source+mediaType+externalId.
	// =====================================================================
	detailRefreshQueue: defineTable({
		syncKey: v.string(),
		mediaType: mediaTypeValidator,
		source: detailSourceValidator,
		externalId: v.number(),
		state: detailRefreshStateValidator,
		priority: v.number(),
		requestedAt: v.number(),
		lastRequestedAt: v.number(),
		nextAttemptAt: v.number(),
		attemptCount: v.number(),
		lastStartedAt: v.optional(v.number()),
		lastFinishedAt: v.optional(v.number()),
		lastSuccessAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string())
	})
		.index('by_syncKey', ['syncKey'])
		.index('by_state_nextAttemptAt', ['state', 'nextAttemptAt'])
		// Used for targeted retention pruning of stale idle rows.
		.index('by_state_lastSuccessAt', ['state', 'lastSuccessAt'])
		// Used for targeted retention pruning of stale error rows.
		.index('by_state_lastFinishedAt', ['state', 'lastFinishedAt'])
		// Used for queue/dashboard listing in reverse recency without full table scans.
		.index('by_state_lastRequestedAt', ['state', 'lastRequestedAt'])
		.index('by_nextRefreshAt', ['nextRefreshAt'])
		.index('by_mediaType_nextAttemptAt', ['mediaType', 'nextAttemptAt']),

	// =====================================================================
	// Transient anime leases used to dedupe title sync jobs and table seeding sweeps.
	// =====================================================================
	animeSyncLeases: defineTable({
		leaseKey: v.string(),
		leaseKind: v.union(v.literal('title_sync'), v.literal('seed_sweep')),
		jobType: v.optional(v.union(v.literal('season'), v.literal('timeline'))),
		tmdbType: v.optional(v.union(v.literal('movie'), v.literal('tv'))),
		tmdbId: v.optional(v.number()),
		seedTable: v.optional(v.union(v.literal('tvShows'), v.literal('movies'))),
		owner: v.string(),
		leasedAt: v.number(),
		leaseExpiresAt: v.number()
	})
		.index('by_leaseKey', ['leaseKey'])
		.index('by_leaseExpiresAt', ['leaseExpiresAt']),

	// =====================================================================
	// Persistent anime sync queue/state (season/timeline) used by quota-aware
	// background workers. One row per TMDB title + job type.
	// =====================================================================
	animeSyncQueue: defineTable({
		syncKey: v.string(),
		jobType: v.union(v.literal('season'), v.literal('timeline')),
		tmdbType: v.union(v.literal('movie'), v.literal('tv')),
		tmdbId: v.number(),
		state: v.union(
			v.literal('idle'),
			v.literal('queued'),
			v.literal('running'),
			v.literal('retry'),
			v.literal('error')
		),
		priority: v.number(),
		requestedAt: v.number(),
		lastRequestedAt: v.number(),
		nextAttemptAt: v.number(),
		attemptCount: v.number(),
		lastStartedAt: v.optional(v.number()),
		lastFinishedAt: v.optional(v.number()),
		lastSuccessAt: v.optional(v.number()),
		nextRefreshAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastResultStatus: v.optional(v.string()),
		// Eligibility gate audit signal (independent of terminal run status).
		// `auto_disagree` is the problematic case that should be surfaced in audits.
		animeEligibilityCheck: v.optional(
			v.union(
				v.literal('agree'),
				v.literal('auto_disagree'),
				v.literal('manual_override_disagree'),
				v.literal('db_missing_used_heuristic')
			)
		),
		estimatedAniListCost: v.optional(v.number())
	})
		.index('by_syncKey', ['syncKey'])
		.index('by_state_nextAttemptAt', ['state', 'nextAttemptAt'])
		.index('by_nextRefreshAt', ['nextRefreshAt'])
		.index('by_jobType_nextAttemptAt', ['jobType', 'nextAttemptAt']),

	// =====================================================================
	// Shared AniList API quota budget state (global token bucket + backoff).
	// =====================================================================
	animeApiBudget: defineTable({
		provider: v.literal('anilist'),
		// Current available quota budget in the token bucket ("fuel in tank").
		tokens: v.number(),
		// Current effective bucket size after adaptive throttling ("tank size").
		capacity: v.number(),
		// Configured baseline bucket size before adaptive throttling (90/min * safety factor).
		baseCapacity: v.number(),
		// Configured baseline refill rate per minute before adaptive throttling.
		refillPerMinute: v.number(),
		lastRefillAt: v.number(),
		// If set and in the future, the worker temporarily pauses new AniList work after 429s
		// and defers reservations until this timestamp.
		cooldownUntil: v.optional(v.number()),
		// 1.0 = no adaptive throttle. <1.0 means AniList rate limiting was observed and
		// the worker reduced effective budget/capacity until it recovers on successes.
		throttleFactor: v.optional(v.number()),
		consecutive429s: v.optional(v.number()),
		last429At: v.optional(v.number()),
		updatedAt: v.number()
	}).index('by_provider', ['provider']),

	// =====================================================================
	// Movie records (multi-source IDs + DB-first detail snapshot).
	// =====================================================================
	movies: defineTable({
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		// Temporary compatibility field for legacy prod rows; remove after slug purge migration.
		slug: v.optional(v.union(v.string(), v.null())),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		runtime: v.optional(v.union(v.number(), v.null())),
		detailSchemaVersion: v.optional(v.number()),
		detailFetchedAt: v.optional(v.union(v.number(), v.null())),
		nextRefreshAt: v.optional(v.number()),
		refreshErrorCount: v.optional(v.number()),
		// Temporary compatibility for legacy rows until details.backfillRequiredDetailFields sets this.
		lastRefreshErrorAt: v.optional(v.union(v.number(), v.null()))
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId'])
		.index('by_isAnime_tmdbId', ['isAnime', 'tmdbId'])
		.index('by_nextRefreshAt', ['nextRefreshAt']),

	// =====================================================================
	// TV records (multi-source IDs + DB-first detail snapshot).
	// =====================================================================
	tvShows: defineTable({
		tmdbId: v.optional(v.number()),
		traktId: v.optional(v.number()),
		imdbId: v.optional(v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		// Temporary compatibility field for legacy prod rows; remove after slug purge migration.
		slug: v.optional(v.union(v.string(), v.null())),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		numberOfSeasons: v.optional(v.union(v.number(), v.null())),
		lastAirDate: v.optional(v.union(v.string(), v.null())),
		lastEpisodeToAir: v.optional(v.union(storedEpisodeSummaryValidator, v.null())),
		nextEpisodeToAir: v.optional(v.union(storedEpisodeSummaryValidator, v.null())),
		detailSchemaVersion: v.optional(v.number()),
		detailFetchedAt: v.optional(v.union(v.number(), v.null())),
		nextRefreshAt: v.optional(v.number()),
		refreshErrorCount: v.optional(v.number()),
		// Temporary compatibility for legacy rows until details.backfillRequiredDetailFields sets this.
		lastRefreshErrorAt: v.optional(v.union(v.number(), v.null()))
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_traktId', ['traktId'])
		.index('by_imdbId', ['imdbId'])
		.index('by_isAnime_tmdbId', ['isAnime', 'tmdbId'])
		.index('by_nextRefreshAt', ['nextRefreshAt']),

	// =====================================================================
	// Manual movie overrides. These rows are never touched by refresh workers.
	// Optional fields only apply when present (undefined = no override).
	// =====================================================================
	movieOverrides: defineTable({
		tmdbId: v.number(),
		// Intended cardinality is one row per tmdbId; read paths pick the newest row if duplicates exist.
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		runtime: v.optional(v.union(v.number(), v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		updatedAt: v.number()
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_updatedAt', ['updatedAt']),

	// =====================================================================
	// Manual TV overrides. These rows are never touched by refresh workers.
	// Optional fields only apply when present (undefined = no override).
	// =====================================================================
	tvOverrides: defineTable({
		tmdbId: v.number(),
		// Intended cardinality is one row per tmdbId; read paths pick the newest row if duplicates exist.
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		numberOfSeasons: v.optional(v.union(v.number(), v.null())),
		lastAirDate: v.optional(v.union(v.string(), v.null())),
		lastEpisodeToAir: v.optional(v.union(storedEpisodeSummaryValidator, v.null())),
		nextEpisodeToAir: v.optional(v.union(storedEpisodeSummaryValidator, v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		updatedAt: v.number()
	})
		.index('by_tmdbId', ['tmdbId'])
		.index('by_updatedAt', ['updatedAt']),

	// =====================================================================
	// Anime cross reference between TMDB <-> AniList
	// =====================================================================
	animeXref: defineTable({
		tmdbType: v.union(v.literal('movie'), v.literal('tv')),
		tmdbId: v.float64(),

		// Glanceable debug snapshot for manual xref auditing. Non-authoritative.
		title: v.object({
			tmdb: v.string(),
			anilistEnglish: v.union(v.string(), v.null()),
			anilistRomaji: v.union(v.string(), v.null())
		}),

		// AniList Media entry to anchor to (ex: TV S1 or a specific movie)
		anilistId: v.float64(),

		confidence: v.float64(),
		method: v.union(
			v.literal('tmdb_external_ids'),
			v.literal('title_year_episodes'),
			v.literal('manual'),
			v.literal('failed')
		),
		locked: v.optional(v.boolean()),

		candidates: v.optional(
			v.array(
				v.object({
					anilistId: v.float64(),
					score: v.float64(),
					why: v.optional(v.string())
				})
			)
		),

		updatedAt: v.float64()
	})
		.index('by_tmdbType_tmdbId', ['tmdbType', 'tmdbId'])
		.index('by_anilistId', ['anilistId']),

	// =====================================================================
	// AniList media enrichment (season/movie-level)
	// =====================================================================
	anilistMedia: defineTable({
		anilistId: v.float64(),

		title: v.object({
			romaji: v.union(v.string(), v.null()),
			english: v.union(v.string(), v.null()),
			native: v.union(v.string(), v.null())
		}),
		format: v.optional(v.string()), // TV, MOVIE, OVA, ONA, SPECIAL...

		// Dates / counts (helpful for matching + timeline ordering)
		startDate: v.optional(
			v.object({
				year: v.union(v.float64(), v.null()),
				month: v.union(v.float64(), v.null()),
				day: v.union(v.float64(), v.null())
			})
		),
		seasonYear: v.optional(v.union(v.float64(), v.null())),
		episodes: v.optional(v.union(v.float64(), v.null())),

		description: v.optional(v.union(v.string(), v.null())),

		studios: v.optional(
			v.array(
				v.object({
					anilistStudioId: v.float64(),
					name: v.string(),
					isAnimationStudio: v.optional(v.boolean()),
					isMain: v.optional(v.boolean())
				})
			)
		),

		fetchedAt: v.float64(),
		schemaVersion: v.float64()
	}).index('by_anilistId', ['anilistId']),

	// =====================================================================
	// Manual title-level anime UI overrides.
	// Used for defaults that should apply across all season rows.
	// =====================================================================
	animeTitleOverrides: defineTable({
		tmdbType: v.union(v.literal('tv'), v.literal('movie')),
		tmdbId: v.float64(),
		defaultEpisodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		),
		// New TMDB-canonical display season model mode.
		// auto = sync regenerates display seasons from TMDB season containers.
		// custom = user-managed display season plan persists across syncs.
		displayPlanMode: v.optional(v.union(v.literal('auto'), v.literal('custom'), v.null())),
		// Explicit title-level display season count override (e.g. One Piece => 1)
		displaySeasonCountOverride: v.optional(v.union(v.float64(), v.null())),
		updatedAt: v.float64()
	}).index('by_tmdb', ['tmdbType', 'tmdbId']),

	// =====================================================================
	// Canonical anime season rows (display seasons) built on top of TMDB episodes.
	// These rows are what the app should render in season selection UI.
	// Auto rows are regenerated from TMDB by sync while title is in displayPlanMode=auto.
	// Manual rows persist across syncs when displayPlanMode=custom.
	// =====================================================================
	animeDisplaySeasons: defineTable({
		tmdbType: v.union(v.literal('tv'), v.literal('movie')),
		tmdbId: v.float64(),
		// Row identity within a title. Intended uniqueness scope is (tmdbType, tmdbId, rowKey).
		rowKey: v.string(),
		label: v.string(),
		sortOrder: v.float64(),
		rowType: v.union(v.literal('main'), v.literal('specials'), v.literal('custom')),
		seasonOrdinal: v.optional(v.union(v.float64(), v.null())),
		episodeNumberingMode: v.optional(
			v.union(v.literal('restarting'), v.literal('continuous'), v.null())
		),
		status: v.optional(
			v.union(
				v.literal('open'),
				v.literal('soft_closed'),
				v.literal('auto_soft_closed'),
				v.literal('closed'),
				v.null()
			)
		),
		// Row lifecycle hint for operators:
		// - open: may continue receiving episodes (when boundaries are known/safe)
		// - soft_closed: likely complete; do not assume future TMDB episodes belong here
		// - auto_soft_closed: system-applied soft-close after long inactivity
		// - closed: finalized historical row
		// Runtime "unassigned" is not stored here; it is computed by report queries when
		// cached TMDB episodes are not covered by any display-season source range.
		hidden: v.optional(v.boolean()),
		sourceMode: v.union(v.literal('auto'), v.literal('manual')),
		locked: v.optional(v.boolean()),
		sources: v.array(
			v.object({
				// Stable identifier for this source block within a display-season row.
				sourceKey: v.string(),
				// Explicit in-row ordering for episode rendering when multiple source
				// ranges are spliced into the same display season.
				sequence: v.float64(),
				tmdbSeasonNumber: v.number(),
				tmdbEpisodeStart: v.union(v.float64(), v.null()),
				tmdbEpisodeEnd: v.union(v.float64(), v.null()),
				// Allows TMDB specials (season 0) to render as regular episodes when
				// manually folded into a main display season.
				displayAsRegularEpisode: v.optional(v.boolean())
			})
		),
		updatedAt: v.float64()
	})
		.index('by_tmdb', ['tmdbType', 'tmdbId'])
		.index('by_tmdb_rowKey', ['tmdbType', 'tmdbId', 'rowKey']),

	// =====================================================================
	// Proactive operator alerts for anime data quality / curation attention.
	// System-managed alerts are deduped by fingerprint and can be acknowledged.
	// =====================================================================
	animeAlerts: defineTable({
		tmdbType: v.union(v.literal('tv'), v.literal('movie')),
		tmdbId: v.float64(),
		scopeType: v.union(
			v.literal('title'),
			v.literal('display_row'),
			v.literal('tmdb_season'),
			v.literal('xref')
		),
		scopeKey: v.optional(v.union(v.string(), v.null())),
		code: v.string(),
		severity: v.union(v.literal('info'), v.literal('warning'), v.literal('error')),
		status: v.union(v.literal('open'), v.literal('acknowledged'), v.literal('resolved')),
		source: v.union(v.literal('season_report'), v.literal('needs_review')),
		fingerprint: v.string(),
		summary: v.string(),
		detailsJson: v.optional(v.union(v.string(), v.null())),
		firstDetectedAt: v.float64(),
		lastDetectedAt: v.float64(),
		lastSeenAt: v.float64(),
		resolvedAt: v.optional(v.union(v.float64(), v.null())),
		updatedAt: v.float64()
	})
		.index('by_tmdb', ['tmdbType', 'tmdbId'])
		.index('by_fingerprint', ['fingerprint'])
		.index('by_status_lastSeenAt', ['status', 'lastSeenAt'])
		.index('by_code_status', ['code', 'status']),

	// Cursor state for bounded cron sweeps that materialize animeAlerts proactively.
	animeAlertSweepState: defineTable({
		table: v.union(v.literal('tvShows'), v.literal('movies')),
		cursor: v.optional(v.union(v.string(), v.null())),
		lastRunAt: v.optional(v.union(v.float64(), v.null())),
		updatedAt: v.float64()
	}).index('by_table', ['table']),

	// =====================================================================
	// Cached TMDB episode lists for anime season rows (by show + season).
	// =====================================================================
	animeEpisodeCache: defineTable({
		tmdbId: v.number(),
		seasonNumber: v.number(),
		episodes: v.array(
			v.object({
				id: v.number(),
				name: v.string(),
				overview: v.union(v.string(), v.null()),
				airDate: v.union(v.string(), v.null()),
				runtime: v.union(v.number(), v.null()),
				episodeNumber: v.number(),
				seasonNumber: v.number(),
				stillPath: v.union(v.string(), v.null())
			})
		),
		fetchedAt: v.number(),
		// Scheduler reads this field to decide when season cache should be refreshed.
		nextRefreshAt: v.number()
	})
		.index('by_tmdbId_seasonNumber', ['tmdbId', 'seasonNumber'])
		.index('by_nextRefreshAt', ['nextRefreshAt']),

	// =====================================================================
	// Minimal person registry used by lazy person graph sync.
	// =====================================================================
	people: defineTable({
		tmdbId: v.number(),
		name: v.string(),
		profilePath: v.union(v.string(), v.null())
	}).index('by_tmdbId', ['tmdbId']),

	// =====================================================================
	// Minimal company/studio registry used by lazy company graph sync.
	// =====================================================================
	companies: defineTable({
		tmdbId: v.number(),
		name: v.string(),
		logoPath: v.union(v.string(), v.null())
	}).index('by_tmdbId', ['tmdbId']),

	// =====================================================================
	// Person-to-movie graph links for entity detail filtering and watched/in-library checks.
	// =====================================================================
	movieCredits: defineTable({
		movieId: v.id('movies'),
		personId: v.id('people'),
		personTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_personTmdbId', ['personTmdbId']),

	// =====================================================================
	// Person-to-TV graph links for entity detail filtering and watched/in-library checks.
	// =====================================================================
	tvCredits: defineTable({
		tvShowId: v.id('tvShows'),
		personId: v.id('people'),
		personTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_personTmdbId', ['personTmdbId']),

	// =====================================================================
	// Company-to-movie graph links for entity detail filtering and watched/in-library checks.
	// =====================================================================
	movieCompanies: defineTable({
		movieId: v.id('movies'),
		companyId: v.id('companies'),
		companyTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_companyTmdbId', ['companyTmdbId']),

	// =====================================================================
	// Company-to-TV graph links for entity detail filtering and watched/in-library checks.
	// =====================================================================
	tvCompanies: defineTable({
		tvShowId: v.id('tvShows'),
		companyId: v.id('companies'),
		companyTmdbId: v.number(),
		mediaTmdbId: v.number(),
		billingOrder: v.number(),
		source: v.literal('tmdb')
	}).index('by_companyTmdbId', ['companyTmdbId']),

	// =====================================================================
	// User movie reviews/ratings; primary per-user library source for movies.
	// =====================================================================
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

	// =====================================================================
	// User TV reviews/ratings; primary per-user library source for TV.
	// =====================================================================
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

	// =====================================================================
	// Secure server-side WorkOS session/refresh-token state.
	// =====================================================================
	userSessions: defineTable(userSessionValidator)
		.index('by_userId', ['userId'])
		.index('by_sessionId', ['sessionId'])
});
