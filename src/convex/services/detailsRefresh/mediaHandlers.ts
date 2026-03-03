import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type {
	InsertMediaArgs,
	StoredMediaSnapshot,
	StoredMovieDoc,
	StoredTVDoc,
	SyncPolicy
} from '../../types/detailsType';

import {
	cloneCreatorCredits,
	dedupeCreatorCredits,
	mergeCreatorCreditsForSource
} from '../../utils/details/creatorCredits';
import {
	buildMovieInsertDoc,
	buildMoviePatch,
	buildTVInsertDoc,
	buildTVPatch
} from '../../utils/details/detailsUtils';
import { getMovieBySource, getTVShowBySource } from '../../utils/mediaLookup';
import { computeRefreshErrorBackoffMs } from '../detailsRefreshService';

const MOVIE_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'tmdb_authoritative',
	backdropPath: 'tmdb_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	runtime: 'tmdb_authoritative',
	isAnime: 'tmdb_authoritative',
	isAnimeSource: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const TV_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'tmdb_authoritative',
	backdropPath: 'tmdb_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	numberOfSeasons: 'tmdb_authoritative',
	seasons: 'tmdb_authoritative',
	lastAirDate: 'tmdb_authoritative',
	lastEpisodeToAir: 'tmdb_authoritative',
	nextEpisodeToAir: 'tmdb_authoritative',
	isAnime: 'tmdb_authoritative',
	isAnimeSource: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

export async function getStoredMediaHandler(
	ctx: QueryCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number | string;
	}
) {
	if (args.mediaType === 'movie') {
		const movie: StoredMovieDoc | null = await getMovieBySource(ctx, args.source, args.externalId);
		if (!movie) return null;
		return {
			posterPath: movie.posterPath,
			backdropPath: movie.backdropPath,
			detailSchemaVersion: movie.detailSchemaVersion ?? null,
			detailFetchedAt: movie.detailFetchedAt ?? null,
			nextRefreshAt: movie.nextRefreshAt ?? null,
			releaseDate: movie.releaseDate ?? null,
			overview: movie.overview ?? null,
			status: movie.status ?? null,
			runtime: movie.runtime ?? null,
			creatorCredits: movie.creatorCredits
		} satisfies StoredMediaSnapshot;
	}

	const tvShow: StoredTVDoc | null = await getTVShowBySource(ctx, args.source, args.externalId);
	if (!tvShow) return null;
	return {
		posterPath: tvShow.posterPath,
		backdropPath: tvShow.backdropPath,
		detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
		detailFetchedAt: tvShow.detailFetchedAt ?? null,
		nextRefreshAt: tvShow.nextRefreshAt ?? null,
		releaseDate: tvShow.releaseDate ?? null,
		overview: tvShow.overview ?? null,
		status: tvShow.status ?? null,
		numberOfSeasons: tvShow.numberOfSeasons ?? null,
		seasons: tvShow.seasons ?? null,
		lastAirDate: tvShow.lastAirDate ?? null,
		lastEpisodeToAir: tvShow.lastEpisodeToAir ?? null,
		nextEpisodeToAir: tvShow.nextEpisodeToAir ?? null,
		creatorCredits: tvShow.creatorCredits
	} satisfies StoredMediaSnapshot;
}

export async function insertMediaHandler(ctx: MutationCtx, args: InsertMediaArgs) {
	const incomingCreatorCredits = dedupeCreatorCredits(cloneCreatorCredits(args.creatorCredits));

	if (args.mediaType === 'movie') {
		const existing: StoredMovieDoc | null = await getMovieBySource(
			ctx,
			args.source,
			args.externalId
		);
		if (!existing) {
			await ctx.db.insert('movies', buildMovieInsertDoc(args, incomingCreatorCredits));
			return;
		}

		const mergedCreatorCredits = mergeCreatorCreditsForSource(
			existing.creatorCredits,
			incomingCreatorCredits,
			'tmdb'
		);
		const patch = buildMoviePatch(existing, args, mergedCreatorCredits, MOVIE_SYNC_POLICY);
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existing._id, patch);
		}
		return;
	}

	const existing: StoredTVDoc | null = await getTVShowBySource(ctx, args.source, args.externalId);
	if (!existing) {
		await ctx.db.insert('tvShows', buildTVInsertDoc(args, incomingCreatorCredits));
		return;
	}

	const mergedCreatorCredits = mergeCreatorCreditsForSource(
		existing.creatorCredits,
		incomingCreatorCredits,
		'tmdb'
	);
	const patch = buildTVPatch(existing, args, mergedCreatorCredits, TV_SYNC_POLICY);
	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}
}

export async function recordRefreshFailureHandler(
	ctx: MutationCtx,
	args: {
		mediaType: 'movie' | 'tv';
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number | string;
		failedAt: number;
	}
) {
	if (args.mediaType === 'movie') {
		const movie: StoredMovieDoc | null = await getMovieBySource(ctx, args.source, args.externalId);
		if (!movie) return;
		const nextErrorCount = (movie.refreshErrorCount ?? 0) + 1;
		const nextRefreshAt = args.failedAt + computeRefreshErrorBackoffMs(nextErrorCount);
		await ctx.db.patch(movie._id, {
			refreshErrorCount: nextErrorCount,
			lastRefreshErrorAt: args.failedAt,
			nextRefreshAt
		});
		return;
	}

	const tvShow: StoredTVDoc | null = await getTVShowBySource(ctx, args.source, args.externalId);
	if (!tvShow) return;
	const nextErrorCount = (tvShow.refreshErrorCount ?? 0) + 1;
	const nextRefreshAt = args.failedAt + computeRefreshErrorBackoffMs(nextErrorCount);
	await ctx.db.patch(tvShow._id, {
		refreshErrorCount: nextErrorCount,
		lastRefreshErrorAt: args.failedAt,
		nextRefreshAt
	});
}
