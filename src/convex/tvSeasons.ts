import type { Doc } from './_generated/dataModel';
import type { ActionCtx, QueryCtx } from './_generated/server';
import type {
	EpisodeCacheRequest,
	TMDBSeasonEpisodeRow,
	TVEpisodeRefreshSignals
} from './types/animeEpisodeTypes';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalMutation, internalQuery, query } from './_generated/server';
import { buildSeasonEpisodesCachedPayload } from './services/anime/episodeCacheService';
import {
	computeEpisodeCacheRefreshTime,
	dedupeEpisodeCacheRequests,
	episodeCacheKey,
	parseTMDBSeasonEpisodes
} from './utils/anime/episodeUtils';
import { getFinalTV, getTVShowBySource } from './utils/mediaLookup';
import { fetchTMDBJson } from './utils/tmdb';

type TVSeasonSummary = {
	id: number;
	name: string;
	overview: string | null;
	airDate: string | null;
	episodeCount: number | null;
	posterPath: string | null;
	seasonNumber: number;
	voteAverage: number | null;
};

type EpisodeCacheRow = Doc<'tvEpisodeCache'>;

const seasonEpisodeArgs = {
	tmdbId: v.number(),
	seasonNumber: v.number(),
	seasonTitle: v.optional(v.string())
};

function normalizeSeasonTitle(season: TVSeasonSummary): string {
	const trimmed = season.name.trim();
	if (trimmed.length > 0) return trimmed;
	return season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`;
}

function buildTVSeasonItems(tmdbId: number, seasons: TVSeasonSummary[]) {
	return seasons
		.filter((season) => season.seasonNumber >= 0)
		.sort((left, right) => {
			const leftIsSpecials = left.seasonNumber === 0;
			const rightIsSpecials = right.seasonNumber === 0;
			if (leftIsSpecials !== rightIsSpecials) {
				return leftIsSpecials ? 1 : -1
			}
			return left.seasonNumber - right.seasonNumber
		})
		.map((season) => {
			const seasonTitle = normalizeSeasonTitle(season);
			return {
				stableSeasonId: season.id,
				orderIndex: season.seasonNumber,
				isMainline: season.seasonNumber > 0,
				isRecap: false,
				discoveredVia: null,
				media: {
					title: {
						english: seasonTitle,
						romaji: seasonTitle,
						native: null
					},
					format: season.seasonNumber === 0 ? 'SPECIAL' : 'TV',
					startDate: null,
					seasonYear: null,
					episodes: season.episodeCount ?? null,
					description: season.overview,
					studios: []
				},
				seasonXref: {
					tmdbType: 'tv',
					tmdbId,
					sourceKey: `tmdb:${tmdbId}:season:${season.seasonNumber}`,
					sequence: 0,
					tmdbSeasonNumber: season.seasonNumber,
					tmdbSeasonName: seasonTitle,
					tmdbEpisodeStart: null,
					tmdbEpisodeEnd: null,
					displayAsRegularEpisode: season.seasonNumber === 0 ? false : null,
					seasonOrdinal: season.seasonNumber > 0 ? season.seasonNumber : null,
					episodeNumberingMode: 'restarting',
					confidence: 1,
					method: 'tmdb',
					locked: false
				},
				seasonGroupKey: `tv:${tmdbId}:season:${season.seasonNumber}`,
				seasonTitle,
				seasonOrdinal: season.seasonNumber > 0 ? season.seasonNumber : null,
				episodeNumberingMode: 'restarting',
				episodeDisplayStart: null,
				seasonSources: [
					{
						tmdbType: 'tv',
						tmdbId,
						sourceKey: `tmdb:${tmdbId}:season:${season.seasonNumber}`,
						sequence: 0,
						tmdbSeasonNumber: season.seasonNumber,
						tmdbSeasonName: seasonTitle,
						tmdbEpisodeStart: null,
						tmdbEpisodeEnd: null,
						displayAsRegularEpisode: season.seasonNumber === 0 ? false : null,
						seasonOrdinal: season.seasonNumber > 0 ? season.seasonNumber : null,
						episodeNumberingMode: 'restarting',
						confidence: 1,
						method: 'tmdb',
						locked: false
					}
				]
			};
		});
}

async function loadEpisodeCacheRowsByRequests(ctx: QueryCtx, requests: EpisodeCacheRequest[]) {
	const dedupedRequests = dedupeEpisodeCacheRequests(requests);
	if (dedupedRequests.length === 0) return [];

	const seasonSetsByTMDB = new Map<number, Set<number>>();
	for (const request of dedupedRequests) {
		const set = seasonSetsByTMDB.get(request.tmdbId) ?? new Set<number>();
		set.add(request.seasonNumber);
		seasonSetsByTMDB.set(request.tmdbId, set);
	}

	const collected = await Promise.all(
		[...seasonSetsByTMDB.entries()].map(async ([tmdbId, seasons]) => {
			const rows = await ctx.db
				.query('tvEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) => q.eq('tmdbId', tmdbId))
				.collect();
			return rows.filter((row) => seasons.has(row.seasonNumber));
		})
	);

	const byKey = new Map<string, Doc<'tvEpisodeCache'>[]>();
	for (const rows of collected) {
		for (const row of rows) {
			const key = episodeCacheKey(row.tmdbId, row.seasonNumber);
			const list = byKey.get(key) ?? [];
			list.push(row);
			byKey.set(key, list);
		}
	}

	const resolved: Doc<'tvEpisodeCache'>[] = [];
	for (const request of dedupedRequests) {
		const key = episodeCacheKey(request.tmdbId, request.seasonNumber);
		const preferred = pickPreferredCacheRow(byKey.get(key) ?? []);
		if (preferred) resolved.push(preferred);
	}
	return resolved;
}

function pickPreferredCacheRow(rows: Doc<'tvEpisodeCache'>[]): Doc<'tvEpisodeCache'> | null {
	let best: Doc<'tvEpisodeCache'> | null = null;
	let bestFetchedAt = Number.NEGATIVE_INFINITY;
	let bestRefreshAt = Number.NEGATIVE_INFINITY;
	let bestCreatedAt = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const fetchedAt = row.fetchedAt ?? 0;
		const nextRefreshAt = row.nextRefreshAt ?? 0;
		const createdAt = row._creationTime ?? 0;
		if (
			best === null ||
			fetchedAt > bestFetchedAt ||
			(fetchedAt === bestFetchedAt && nextRefreshAt > bestRefreshAt) ||
			(fetchedAt === bestFetchedAt && nextRefreshAt === bestRefreshAt && createdAt > bestCreatedAt)
		) {
			best = row;
			bestFetchedAt = fetchedAt;
			bestRefreshAt = nextRefreshAt;
			bestCreatedAt = createdAt;
		}
	}
	return best;
}

async function fetchSeasonEpisodesWithCache(
	ctx: ActionCtx,
	requests: EpisodeCacheRequest[]
): Promise<Map<string, TMDBSeasonEpisodeRow[]>> {
	const dedupedRequests = dedupeEpisodeCacheRequests(requests);
	if (dedupedRequests.length === 0) return new Map();

	const cacheRows = (await ctx.runQuery(internal.tvSeasons.getEpisodeCachesBySeasons, {
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
		await ctx.runMutation(internal.tvSeasons.upsertEpisodeCaches, {
			rows: rowsToUpsert
		});
	}

	return result;
}

export const getEpisodeCachesBySeasons = internalQuery({
	args: {
		requests: v.array(
			v.object({
				tmdbId: v.number(),
				seasonNumber: v.number()
			})
		)
	},
	handler: async (ctx, args) => {
		return await loadEpisodeCacheRowsByRequests(ctx, args.requests);
	}
});

export const upsertEpisodeCaches = internalMutation({
	args: {
		rows: v.array(
			v.object({
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
				nextRefreshAt: v.number()
			})
		)
	},
	handler: async (ctx, args) => {
		let inserted = 0;
		let updated = 0;
		for (const row of args.rows) {
			const existing = await ctx.db
				.query('tvEpisodeCache')
				.withIndex('by_tmdbId_seasonNumber', (q) =>
					q.eq('tmdbId', row.tmdbId).eq('seasonNumber', row.seasonNumber)
				)
				.collect();
			const [first, ...duplicates] = existing;
			for (const duplicate of duplicates) {
				await ctx.db.delete(duplicate._id);
			}
			if (first) {
				await ctx.db.patch(first._id, {
					episodes: row.episodes,
					fetchedAt: row.fetchedAt,
					nextRefreshAt: row.nextRefreshAt
				});
				updated += 1;
			} else {
				await ctx.db.insert('tvEpisodeCache', row);
				inserted += 1;
			}
		}
		return { inserted, updated };
	}
});

export const getTVSeasons = query({
	args: {
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		const tvShowBase = await getTVShowBySource(ctx, 'tmdb', args.tmdbId);
		if (!tvShowBase) return null;
		const tvShow = await getFinalTV(ctx, tvShowBase);
		const storedSeasons = (tvShow.seasons ?? null) as TVSeasonSummary[] | null;
		if (storedSeasons == null) return null;
		if ((tvShow.numberOfSeasons ?? 0) > 0 && storedSeasons.length === 0) return null;

		const seasons = buildTVSeasonItems(args.tmdbId, storedSeasons);
		const selectedSeason =
			seasons.find((season) => season.seasonOrdinal != null) ?? seasons[0] ?? null;

		return {
			seasons,
			displaySeasonCount:
				tvShow.numberOfSeasons ?? seasons.filter((season) => season.seasonOrdinal != null).length,
			selectedSeason
		};
	}
});

export const getSeasonEpisodesCached = query({
	args: seasonEpisodeArgs,
	handler: async (ctx, args) => {
		const seasonRequests = [{ tmdbId: args.tmdbId, seasonNumber: args.seasonNumber }];
		const cacheRows = await loadEpisodeCacheRowsByRequests(ctx, seasonRequests);
		const payload = buildSeasonEpisodesCachedPayload({
			seasonTitle: args.seasonTitle,
			seasonRequests,
			cacheRows: cacheRows as EpisodeCacheRow[]
		});
		const episodes = (
			payload.episodeSeasonCache.get(episodeCacheKey(args.tmdbId, args.seasonNumber)) ?? []
		).map((episode) => ({
			id: `tv:${args.tmdbId}:${args.seasonNumber}:${episode.episodeNumber}`,
			tmdbType: 'tv',
			tmdbId: args.tmdbId,
			tmdbSeasonNumber: args.seasonNumber,
			tmdbEpisodeNumber: episode.episodeNumber,
			displayEpisodeNumber: episode.episodeNumber,
			displayNumberLabel:
				args.seasonNumber === 0 ? `SP${episode.episodeNumber}` : `E${episode.episodeNumber}`,
			title: episode.name,
			overview: episode.overview,
			airDate: episode.airDate,
			runtime: episode.runtime,
			stillPath: episode.stillPath
		}));

		return {
			seasonTitle: payload.seasonTitle,
			episodes,
			cacheStatus: payload.cacheStatus,
			hasMissingSeasons: payload.hasMissingSeasons,
			hasStaleSeasons: payload.hasStaleSeasons,
			missingSeasonCount: payload.missingSeasonCount,
			staleSeasonCount: payload.staleSeasonCount,
			totalSeasonCount: payload.totalSeasonCount
		};
	}
});

export const refreshSeasonEpisodesCache = action({
	args: seasonEpisodeArgs,
	handler: async (ctx, args) => {
		const refreshedRequests = [{ tmdbId: args.tmdbId, seasonNumber: args.seasonNumber }];
		await fetchSeasonEpisodesWithCache(ctx, refreshedRequests);
		return {
			ok: true,
			refreshed: refreshedRequests.length
		};
	}
});
