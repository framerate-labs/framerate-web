import type { ActionCtx, QueryCtx } from '../../_generated/server';
import type {
	EpisodeCacheRequest,
	SeasonEpisodesCacheStatus,
	TMDBSeasonEpisodeRow,
	TVEpisodeRefreshSignals
} from '../../types/animeEpisodeTypes';

import { internal } from '../../_generated/api';
import {
	computeEpisodeCacheRefreshTime,
	dedupeEpisodeCacheRequests,
	episodeCacheKey,
	loadEpisodeCacheRowsByRequests,
	parseTMDBSeasonEpisodes
} from '../../utils/anime/episodeUtils';
import { fetchTMDBJson } from '../../utils/tmdb';

type EpisodeCacheRow = {
	_id: string;
	tmdbId: number;
	seasonNumber: number;
	episodes: TMDBSeasonEpisodeRow[];
	fetchedAt: number;
	nextRefreshAt: number;
};

export async function fetchSeasonEpisodesWithCache(
	ctx: ActionCtx,
	requests: EpisodeCacheRequest[]
): Promise<Map<string, TMDBSeasonEpisodeRow[]>> {
	const dedupedRequests = dedupeEpisodeCacheRequests(requests);
	if (dedupedRequests.length === 0) return new Map();

	const cacheRows = (await ctx.runQuery(internal.animeSeasons.getEpisodeCachesBySeasons, {
		requests: dedupedRequests
	})) as EpisodeCacheRow[];
	const cacheByKey = new Map(
		cacheRows.map((row) => [episodeCacheKey(row.tmdbId, row.seasonNumber), row] as const)
	);
	const tvSignalsRows = (await ctx.runQuery(
		internal.animeSync.getTVEpisodeRefreshSignalsByTMDBIds,
		{
			tmdbIds: dedupedRequests.map((request) => request.tmdbId)
		}
	)) as TVEpisodeRefreshSignals[];
	const tvSignalsByTmdbId = new Map(tvSignalsRows.map((row) => [row.tmdbId, row] as const));

	const now = Date.now();
	const result = new Map<string, TMDBSeasonEpisodeRow[]>();
	const rowsToUpsert: Array<{
		tmdbId: number;
		seasonNumber: number;
		episodes: TMDBSeasonEpisodeRow[];
		fetchedAt: number;
		nextRefreshAt: number;
	}> = [];

	for (const request of dedupedRequests) {
		const key = episodeCacheKey(request.tmdbId, request.seasonNumber);
		const cached = cacheByKey.get(key);
		const isFresh = cached ? (cached.nextRefreshAt ?? 0) > now : false;
		if (cached && isFresh) {
			result.set(key, cached.episodes);
			continue;
		}

		if (cached && !isFresh) {
			try {
				const raw = await fetchTMDBJson(`/tv/${request.tmdbId}/season/${request.seasonNumber}`);
				const episodes = parseTMDBSeasonEpisodes(raw);
				result.set(key, episodes);
				rowsToUpsert.push({
					tmdbId: request.tmdbId,
					seasonNumber: request.seasonNumber,
					episodes,
					fetchedAt: now,
					nextRefreshAt: computeEpisodeCacheRefreshTime({
						now,
						seasonNumber: request.seasonNumber,
						episodes,
						signals: tvSignalsByTmdbId.get(request.tmdbId) ?? null
					})
				});
			} catch {
				result.set(key, cached.episodes);
			}
			continue;
		}

		const raw = await fetchTMDBJson(`/tv/${request.tmdbId}/season/${request.seasonNumber}`);
		const episodes = parseTMDBSeasonEpisodes(raw);
		result.set(key, episodes);
		rowsToUpsert.push({
			tmdbId: request.tmdbId,
			seasonNumber: request.seasonNumber,
			episodes,
			fetchedAt: now,
			nextRefreshAt: computeEpisodeCacheRefreshTime({
				now,
				seasonNumber: request.seasonNumber,
				episodes,
				signals: tvSignalsByTmdbId.get(request.tmdbId) ?? null
			})
		});
	}

	if (rowsToUpsert.length > 0) {
		await ctx.runMutation(internal.animeSeasons.upsertEpisodeCaches, {
			rows: rowsToUpsert
		});
		const touchedSeasonsByTmdbId = new Map<number, Set<number>>();
		for (const row of rowsToUpsert) {
			const set = touchedSeasonsByTmdbId.get(row.tmdbId) ?? new Set<number>();
			set.add(row.seasonNumber);
			touchedSeasonsByTmdbId.set(row.tmdbId, set);
		}
		for (const [tmdbId, seasonSet] of touchedSeasonsByTmdbId) {
			await ctx.runMutation(internal.animeAlerts.clearMissingEpisodeCacheAlertsForSeasons, {
				tmdbType: 'tv',
				tmdbId,
				seasonNumbers: [...seasonSet]
			});
		}
		const touchedTmdbIds = [...new Set(rowsToUpsert.map((row) => row.tmdbId))];
		for (const tmdbId of touchedTmdbIds) {
			await ctx.runMutation(
				internal.animeSeasons.reconcileAutoDisplaySeasonBoundsFromEpisodeCache,
				{
					tmdbId
				}
			);
		}
	}

	return result;
}

export async function getEpisodeCacheRowsFromDB(ctx: QueryCtx, requests: EpisodeCacheRequest[]) {
	return await loadEpisodeCacheRowsByRequests(ctx.db, requests);
}

export function buildSeasonEpisodesCachedPayload(args: {
	seasonTitle?: string;
	seasonRequests: EpisodeCacheRequest[];
	cacheRows: EpisodeCacheRow[];
}) {
	const now = Date.now();
	const cacheByKey = new Map(
		args.cacheRows.map((row) => [episodeCacheKey(row.tmdbId, row.seasonNumber), row] as const)
	);
	const missingRequests = args.seasonRequests.filter(
		(request) => !cacheByKey.has(episodeCacheKey(request.tmdbId, request.seasonNumber))
	);
	const staleRequests = args.seasonRequests.filter((request) => {
		const row = cacheByKey.get(episodeCacheKey(request.tmdbId, request.seasonNumber));
		if (!row) return false;
		return (row.nextRefreshAt ?? 0) <= now;
	});
	const cacheStatus: SeasonEpisodesCacheStatus =
		args.seasonRequests.length === 0 || (missingRequests.length === 0 && staleRequests.length === 0)
			? 'fresh'
			: missingRequests.length > 0 && args.cacheRows.length === 0
				? 'empty'
				: missingRequests.length > 0
					? 'partial'
					: 'stale';
	const episodeSeasonCache = new Map(
		args.cacheRows.map((row) => [
			episodeCacheKey(row.tmdbId, row.seasonNumber),
			row.episodes as TMDBSeasonEpisodeRow[]
		])
	);
	return {
		seasonTitle: args.seasonTitle ?? null,
		cacheStatus,
		hasMissingSeasons: missingRequests.length > 0,
		hasStaleSeasons: staleRequests.length > 0,
		missingSeasonCount: missingRequests.length,
		staleSeasonCount: staleRequests.length,
		totalSeasonCount: args.seasonRequests.length,
		seasonRequests: args.seasonRequests,
		episodeSeasonCache
	};
}
