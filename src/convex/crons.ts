import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Refresh all trending data every hour
// This keeps the cache fresh without hitting TMDB on every client request
crons.interval(
	'refresh trending cache',
	{ hours: 1 },
	internal.trending.refreshAllTrending
);


// Clean up search caches and rate-limit buckets every 30 minutes
crons.interval(
	'cleanup search artifacts',
	{ minutes: 30 },
	internal.search.cleanupSearchArtifacts
);

export default crons;

