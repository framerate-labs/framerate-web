import { cronJobs } from 'convex/server';

import { internal } from './_generated/api';

const crons = cronJobs();

// Refresh all trending data every hour.
// Solves: avoids per-request TMDB fanout for home/trending surfaces while keeping cache reasonably fresh.
crons.interval('refresh trending cache', { hours: 1 }, internal.trending.refreshAllTrending);

// Clean up ephemeral search artifacts and stale rate-limit bookkeeping.
// Solves: unbounded growth of search cache/bucket rows.
crons.interval('cleanup search artifacts', { minutes: 30 }, internal.search.cleanupSearchArtifacts);

// Seed stale media rows into the persistent detail refresh queue.
// Solves: proactive recency maintenance while allowing queue-level retries/visibility.
crons.interval(
	'enqueue stale detail refreshes',
	{ minutes: 30 },
	internal.detailsRefresh.enqueueStaleDetailRefreshes,
	{
		limit: 200,
		limitPerType: 150
	}
);

// Process the persistent detail refresh queue in bounded batches.
// Solves: controlled TMDB fanout with retry/backoff and durable job state.
crons.interval(
	'process detail refresh queue',
	{ minutes: 5 },
	internal.detailsRefresh.processDetailRefreshQueue,
	{
		maxJobs: 8
	}
);

// Re-queue anime picker sync rows whose anime-specific nextRefreshAt has expired.
// Solves: keeps previously-enriched anime rows fresh over time using animeSyncQueue TTLs.
crons.interval(
	'enqueue stale anime picker refreshes',
	{ minutes: 15 },
	internal.anime.enqueueStaleAnimePickerRefreshes,
	{ limit: 100 }
);

// Seed the anime sync queue from stored anime media so non-interactive rows still enter
// the existing quota-aware anime enrichment pipeline. Runs infrequently because the queue
// itself handles freshness cadence after a row exists.
// Solves: anime rows that exist in movies/tvShows but have never been opened (and thus never queued).
crons.interval(
	'seed anime queue from tv shows',
	{ hours: 6 },
	internal.anime.seedAnimeSyncQueueFromStoredMedia,
	{
		table: 'tvShows',
		limit: 200
	}
);
crons.interval(
	'seed anime queue from movies',
	{ hours: 6 },
	internal.anime.seedAnimeSyncQueueFromStoredMedia,
	{
		table: 'movies',
		limit: 200
	}
);

// Process the shared anime sync queue in small quota-aware batches.
// Solves: centralizes AniList budget/rate-limit handling for both interactive and background anime enrichment.
crons.interval('process anime sync queue', { minutes: 1 }, internal.anime.processAnimeSyncQueue, {
	maxJobs: 4
});

// Proactively materialize animeAlerts so data-quality issues are visible in the dashboard
// even when operators edit rows directly in Convex (bypassing action hooks).
// Bounded page size + persisted cursor keep this sweep cheap and incremental.
crons.interval(
	'materialize anime alerts sweep',
	{ hours: 1 },
	internal.anime.sweepAnimeAlertsMaterialized,
	{
		limitPerTable: 40
	}
);

export default crons;
