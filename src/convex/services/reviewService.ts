import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { MediaSource } from '../utils/mediaLookup';
import type {
	ExternalSourceIds,
	MovieSeedData,
	ResolvedMedia,
	ReviewMediaType,
	TVSeedData
} from '../types/reviewTypes';

import { api } from '../_generated/api';
import { getMovieBySource, getTVShowBySource } from '../utils/mediaLookup';

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
		refreshErrorCount: 0,
		lastRefreshErrorAt: null
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
		refreshErrorCount: 0,
		lastRefreshErrorAt: null
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
		return { mediaType: 'movie', mediaId, shouldHydrateDetails: true };
	}

	const tvShow = await getTVShowBySource(ctx, args.source, args.externalId);
	if (tvShow) {
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
		await ctx.scheduler.runAfter(0, api.detailsRefresh.refreshIfStale, {
			mediaType,
			id: externalId,
			source: 'tmdb',
			force: true
		});
	} catch {
		// Best effort only; review writes should not fail if hydration scheduling fails.
	}
}
