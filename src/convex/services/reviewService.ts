import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type {
	ExternalSourceIds,
	MovieSeedData,
	ResolvedMedia,
	ReviewMediaType,
	TVSeedData
} from '../types/reviewTypes';
import type { MediaSource } from '../utils/mediaLookup';

import { getMovieBySource, getTVShowBySource } from '../utils/mediaLookup';
import {
	ensureDetailRefreshQueueRow,
	requestDetailRefreshQueueRow
} from './detailsRefresh/queueState';
import {
	DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY
} from './detailsRefresh/constants';
import { scheduleDetailRefreshWorkerIfNeededHandler } from './detailsRefresh/queueHandlers';
const DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS = 20 * 60_000;

type HydratableMedia = {
	detailSchemaVersion?: number | null;
	detailFetchedAt?: number | null;
	creatorCredits?: unknown[] | null;
};

export type EnsureMediaResult =
	| { mediaType: 'movie'; mediaId: Id<'movies'>; shouldHydrateDetails: boolean }
	| { mediaType: 'tv'; mediaId: Id<'tvShows'>; shouldHydrateDetails: boolean };

type SeedArgs = {
	source: MediaSource;
	externalId: number | string;
	title: string;
	posterPath: string | null;
	now: number;
};

function needsDetailHydration(media: HydratableMedia): boolean {
	return (
		(media.detailSchemaVersion ?? 0) < 1 ||
		media.detailFetchedAt === null ||
		media.detailFetchedAt === undefined ||
		(media.creatorCredits ?? []).length === 0
	);
}

function applyExternalSourceId(
	target: ExternalSourceIds,
	source: MediaSource,
	externalId: number | string
): void {
	if (source === 'tmdb') {
		target.tmdbId = externalId as number;
		return;
	}
	if (source === 'trakt') {
		target.traktId = externalId as number;
		return;
	}
	target.imdbId = externalId as string;
}

function createMovieSeedData(args: SeedArgs) {
	const movieData: MovieSeedData = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: null,
		releaseDate: null,
		overview: null,
		status: null,
		runtime: null,
		director: null,
		creatorCredits: [],
		detailSchemaVersion: 0,
		detailFetchedAt: null,
		nextRefreshAt: args.now,
		refreshErrorCount: 0
	};
	applyExternalSourceId(movieData, args.source, args.externalId);
	return movieData;
}

function createTVSeedData(args: SeedArgs) {
	const tvShowData: TVSeedData = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: null,
		releaseDate: null,
		overview: null,
		status: null,
		numberOfSeasons: null,
		lastAirDate: null,
		lastEpisodeToAir: null,
		nextEpisodeToAir: null,
		creator: null,
		creatorCredits: [],
		detailSchemaVersion: 0,
		detailFetchedAt: null,
		nextRefreshAt: args.now,
		refreshErrorCount: 0
	};
	applyExternalSourceId(tvShowData, args.source, args.externalId);
	return tvShowData;
}

export async function resolveMedia(
	ctx: QueryCtx | MutationCtx,
	mediaType: ReviewMediaType,
	source: MediaSource,
	externalId: number | string
): Promise<ResolvedMedia | null> {
	if (mediaType === 'movie') {
		const movie = await getMovieBySource(ctx, source, externalId);
		return movie ? { mediaType: 'movie', media: movie } : null;
	}

	const tvShow = await getTVShowBySource(ctx, source, externalId);
	return tvShow ? { mediaType: 'tv', media: tvShow } : null;
}

export async function ensureMediaRecord(
	ctx: MutationCtx,
	args: {
		mediaType: ReviewMediaType;
		source: MediaSource;
		externalId: number | string;
		title: string;
		posterPath: string | null;
		now: number;
	}
): Promise<EnsureMediaResult> {
	if (args.mediaType === 'movie') {
		const movie = await getMovieBySource(ctx, args.source, args.externalId);
		if (movie) {
			if (args.source === 'tmdb' && typeof args.externalId === 'number') {
				await ensureDetailRefreshQueueRow(ctx, {
					mediaType: 'movie',
					source: 'tmdb',
					externalId: args.externalId,
					now: args.now,
					initialNextRefreshAt: movie.nextRefreshAt ?? args.now
				});
			}
			return {
				mediaType: 'movie',
				mediaId: movie._id,
				shouldHydrateDetails: needsDetailHydration(movie)
			};
		}

		const mediaId = await ctx.db.insert(
			'movies',
			createMovieSeedData({
				source: args.source,
				externalId: args.externalId,
				title: args.title,
				posterPath: args.posterPath,
				now: args.now
			})
		);
		if (args.source === 'tmdb' && typeof args.externalId === 'number') {
			await ensureDetailRefreshQueueRow(ctx, {
				mediaType: 'movie',
				source: 'tmdb',
				externalId: args.externalId,
				now: args.now,
				initialNextRefreshAt: args.now
			});
		}
		return { mediaType: 'movie', mediaId, shouldHydrateDetails: true };
	}

	const tvShow = await getTVShowBySource(ctx, args.source, args.externalId);
	if (tvShow) {
		if (args.source === 'tmdb' && typeof args.externalId === 'number') {
			await ensureDetailRefreshQueueRow(ctx, {
				mediaType: 'tv',
				source: 'tmdb',
				externalId: args.externalId,
				now: args.now,
				initialNextRefreshAt: tvShow.nextRefreshAt ?? args.now
			});
		}
		return {
			mediaType: 'tv',
			mediaId: tvShow._id,
			shouldHydrateDetails: needsDetailHydration(tvShow)
		};
	}

	const mediaId = await ctx.db.insert(
		'tvShows',
		createTVSeedData({
			source: args.source,
			externalId: args.externalId,
			title: args.title,
			posterPath: args.posterPath,
			now: args.now
		})
	);
	if (args.source === 'tmdb' && typeof args.externalId === 'number') {
		await ensureDetailRefreshQueueRow(ctx, {
			mediaType: 'tv',
			source: 'tmdb',
			externalId: args.externalId,
			now: args.now,
			initialNextRefreshAt: args.now
		});
	}
	return { mediaType: 'tv', mediaId, shouldHydrateDetails: true };
}

export async function scheduleDetailHydrationForTMDB(
	ctx: MutationCtx,
	mediaType: ReviewMediaType,
	source: MediaSource,
	externalId: number | string
): Promise<void> {
	if (source !== 'tmdb' || typeof externalId !== 'number') return;

	try {
		const now = Date.now();
		const request = await requestDetailRefreshQueueRow(ctx, {
			mediaType,
			source: 'tmdb',
			externalId,
			now,
			priority: DETAIL_REFRESH_QUEUE_INTERACTIVE_PRIORITY,
			force: true,
			staleRunningAfterMs: DETAIL_REFRESH_QUEUE_RUNNING_STALE_MS
		});
		if (request.queued) {
			await scheduleDetailRefreshWorkerIfNeededHandler(ctx, {
				now,
				maxJobs: 1,
				preferredRowId: request.rowId
			});
		}
	} catch {
		// Best effort only; review writes should not fail if hydration scheduling fails.
	}
}
