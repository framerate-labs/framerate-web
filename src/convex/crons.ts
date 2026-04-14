import { cronJobs } from 'convex/server';

import { internal } from './_generated/api';

const crons = cronJobs();

// Keep cadence/limit knobs centralized so queue pressure can be tuned without
// touching each schedule callsite.
const DETAIL_PROCESS_MAX_JOBS = 20;
const DETAIL_QUEUE_MAINTENANCE_PAGE_SIZE = 250;
const DETAIL_QUEUE_PRUNE_LIMIT = 200;
const ANIME_ENQUEUE_STALE_LIMIT = 100;
const ANIME_SEED_LIMIT = 200;
const ANIME_PROCESS_MAX_JOBS = 4;
const ANIME_ALERT_SWEEP_LIMIT_PER_TABLE = 40;

// Refresh all trending data every 6 hours.
// Solves: avoids per-request TMDB fanout for home/trending surfaces while keeping cache reasonably fresh.
crons.interval('refresh trending cache', { hours: 6 }, internal.trending.refreshAllTrending);

// Clean up ephemeral search artifacts and stale rate-limit bookkeeping.
// Solves: unbounded growth of search cache/bucket rows.
crons.interval('cleanup search artifacts', { minutes: 30 }, internal.search.cleanupSearchArtifacts);

// Prune long-idle entity cache rows.
// Solves: unbounded growth of person/company page cache.
crons.interval(
	'cleanup entity page cache',
	{ hours: 12 },
	internal.entities.cleanupEntityPageCacheArtifacts
);

// Process the persistent detail refresh queue in bounded batches.
// Solves: controlled TMDB fanout with retry/backoff and durable job state.
// Queue rows are kept authoritative by insertion paths and refresh outcome writes,
// so the worker can claim due idle rows directly without rescanning media tables.
crons.interval(
	'process detail refresh queue',
	{ minutes: 5 },
	internal.detailsRefresh.processDetailRefreshQueue,
	{
		maxJobs: DETAIL_PROCESS_MAX_JOBS
	}
);

// Prune long-idle detail queue rows separately so steady-state worker runs stay
// focused on executing refresh work instead of paying maintenance costs.
crons.interval(
	'prune detail refresh queue',
	{ hours: 12 },
	internal.detailsRefresh.pruneDetailRefreshQueue,
	{
		limit: DETAIL_QUEUE_PRUNE_LIMIT
	}
);

// Backfill missing queue rows for TMDB titles inserted or edited outside the normal write path.
// This is a slow-moving integrity sweep, not a stale-work discovery pass.
crons.interval(
	'backfill detail refresh queue coverage',
	{ hours: 24 },
	internal.detailsRefresh.backfillMissingDetailRefreshQueueRows,
	{
		pageSize: DETAIL_QUEUE_MAINTENANCE_PAGE_SIZE
	}
);

// Repair duplicate or malformed detail refresh artifacts before they can violate unique-read assumptions.
// Runs infrequently so steady-state refresh traffic is not paying this cost.
crons.interval(
	'repair detail refresh artifacts',
	{ hours: 24 * 7 },
	internal.detailsRefresh.repairDetailRefreshArtifacts
);

// Re-queue anime season sync rows whose anime-specific nextRefreshAt has expired.
// Solves: keeps previously-enriched anime rows fresh over time using animeSyncQueue TTLs.
crons.interval(
	'enqueue stale anime season refreshes',
	{ minutes: 30 },
	internal.animeSync.enqueueStaleAnimeSeasonRefreshes,
	{ limit: ANIME_ENQUEUE_STALE_LIMIT }
);

// Seed the anime sync queue from stored anime media so non-interactive rows still enter
// the existing quota-aware anime enrichment pipeline. Runs infrequently because the queue
// itself handles freshness cadence after a row exists.
// Solves: anime rows that exist in movies/tvShows but have never been opened (and thus never queued).
crons.interval(
	'seed anime queue from tv shows',
	{ hours: 6 },
	internal.animeSync.seedAnimeSyncQueueFromStoredMedia,
	{
		table: 'tvShows',
		limit: ANIME_SEED_LIMIT
	}
);
crons.interval(
	'seed anime queue from movies',
	{ hours: 6 },
	internal.animeSync.seedAnimeSyncQueueFromStoredMedia,
	{
		table: 'movies',
		limit: ANIME_SEED_LIMIT
	}
);

// Process the shared anime sync queue in small quota-aware batches.
// Solves: centralizes AniList budget/rate-limit handling for both interactive and background anime enrichment.
crons.interval(
	'process anime sync queue',
	{ minutes: 5 },
	internal.animeSync.processAnimeSyncQueue,
	{
		maxJobs: ANIME_PROCESS_MAX_JOBS
	}
);

// Proactively materialize animeAlerts so data-quality issues are visible in the dashboard
// even when operators edit rows directly in Convex (bypassing action hooks).
// Bounded page size + persisted cursor keep this sweep cheap and incremental.
crons.interval(
	'materialize anime alerts sweep',
	{ hours: 1 },
	internal.animeAlerts.sweepAnimeAlertsMaterialized,
	{
		limitPerTable: ANIME_ALERT_SWEEP_LIMIT_PER_TABLE
	}
);

// Prune old unique-view buckets after they have served their dedupe purpose.
crons.interval(
	'cleanup collection view windows',
	{ hours: 12 },
	internal.collections.cleanupCollectionViewWindowsNow
);

export default crons;
