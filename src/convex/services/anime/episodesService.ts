import type { SeasonSourceInput, TMDBSeasonEpisodeRow } from '../../types/animeEpisodeTypes';

import {
	normalizeSeasonSourcesForEpisodes,
	parseTMDBSeasonEpisodes,
	sliceSeasonEpisodesForSource
} from '../../utils/anime/episodeUtils';
import { fetchTMDBJson } from '../../utils/tmdb';

type SeasonEpisodeRow = {
	id: string;
	tmdbType: string;
	tmdbId: number;
	tmdbSeasonNumber: number;
	tmdbEpisodeNumber: number;
	displayEpisodeNumber: number | null;
	displayNumberLabel: string;
	title: string;
	overview: string | null;
	airDate: string | null;
	runtime: number | null;
	stillPath: string | null;
};

export type SeasonNumberingRowInput = {
	seasonRowKey?: string;
	episodeNumberingMode?: 'restarting' | 'continuous' | null;
	sources: SeasonSourceInput[];
};

export async function fetchEpisodesForSeasonSources(
	sources: SeasonSourceInput[],
	preloadedSeasonCache?: Map<string, TMDBSeasonEpisodeRow[]>,
	options?: {
		allowNetworkFetch?: boolean;
		episodeNumberingMode?: 'restarting' | 'continuous' | null;
		episodeDisplayStart?: number | null;
	}
): Promise<SeasonEpisodeRow[]> {
	const seasonFetchCache = new Map<string, TMDBSeasonEpisodeRow[]>(preloadedSeasonCache ?? []);
	const allowNetworkFetch = options?.allowNetworkFetch ?? true;
	const requestedNumberingMode = options?.episodeNumberingMode ?? 'restarting';
	const results: SeasonEpisodeRow[] = [];

	let specialLabelCounter = 1;
	let continuousEpisodeNumber = Math.max(1, options?.episodeDisplayStart ?? 1);
	let restartingEpisodeNumber = 1;
	for (const source of sources) {
		if (source.tmdbType !== 'tv') continue;
		const seasonNumber = source.tmdbSeasonNumber ?? null;
		if (seasonNumber == null) continue;

		const cacheKey = `${source.tmdbId}:${seasonNumber}`;
		let seasonEpisodes = seasonFetchCache.get(cacheKey);
		if (!seasonEpisodes) {
			if (!allowNetworkFetch) continue;
			const raw = await fetchTMDBJson(`/tv/${source.tmdbId}/season/${seasonNumber}`);
			seasonEpisodes = parseTMDBSeasonEpisodes(raw);
			seasonFetchCache.set(cacheKey, seasonEpisodes);
		}

		const sliced = sliceSeasonEpisodesForSource(seasonEpisodes, source);

		for (const episode of sliced) {
			const treatSpecialAsRegular = seasonNumber === 0 && source.displayAsRegularEpisode === true;
			if (seasonNumber === 0 && !treatSpecialAsRegular) {
				results.push({
					id: `tv:${source.tmdbId}:0:${episode.episodeNumber}`,
					tmdbType: 'tv',
					tmdbId: source.tmdbId,
					tmdbSeasonNumber: 0,
					tmdbEpisodeNumber: episode.episodeNumber,
					displayEpisodeNumber: null,
					displayNumberLabel: `SP${specialLabelCounter}`,
					title: episode.name,
					overview: episode.overview,
					airDate: episode.airDate,
					runtime: episode.runtime,
					stillPath: episode.stillPath
				});
				specialLabelCounter += 1;
				continue;
			}

			const displayEpisodeNumber =
				requestedNumberingMode === 'restarting' ? restartingEpisodeNumber : continuousEpisodeNumber;
			results.push({
				id: `tv:${source.tmdbId}:${seasonNumber}:${episode.episodeNumber}`,
				tmdbType: 'tv',
				tmdbId: source.tmdbId,
				tmdbSeasonNumber: seasonNumber,
				tmdbEpisodeNumber: episode.episodeNumber,
				displayEpisodeNumber,
				displayNumberLabel: `E${displayEpisodeNumber}`,
				title: episode.name,
				overview: episode.overview,
				airDate: episode.airDate,
				runtime: episode.runtime,
				stillPath: episode.stillPath
			});
			if (requestedNumberingMode === 'continuous') {
				continuousEpisodeNumber += 1;
			}
			restartingEpisodeNumber += 1;
		}
	}

	return results;
}

async function countRenderedNonSpecialEpisodesForSeasonSources(
	sources: SeasonSourceInput[],
	seasonFetchCache: Map<string, TMDBSeasonEpisodeRow[]>,
	allowNetworkFetch: boolean
): Promise<number | null> {
	let total = 0;
	for (const source of sources) {
		if (source.tmdbType !== 'tv') continue;
		const seasonNumber = source.tmdbSeasonNumber ?? null;
		if (seasonNumber == null) continue;
		if (seasonNumber == 0 && source.displayAsRegularEpisode !== true) continue;

		const cacheKey = `${source.tmdbId}:${seasonNumber}`;
		let seasonEpisodes = seasonFetchCache.get(cacheKey);
		if (!seasonEpisodes) {
			if (!allowNetworkFetch) return null;
			const raw = await fetchTMDBJson(`/tv/${source.tmdbId}/season/${seasonNumber}`);
			seasonEpisodes = parseTMDBSeasonEpisodes(raw);
			seasonFetchCache.set(cacheKey, seasonEpisodes);
		}

		const count = sliceSeasonEpisodesForSource(seasonEpisodes, source).length;
		total += count;
	}
	return total;
}

export async function computeEpisodeDisplayStartFromSeasonRows(
	numberingRows: SeasonNumberingRowInput[],
	selectedSeasonRowKey: string,
	seasonFetchCache: Map<string, TMDBSeasonEpisodeRow[]>,
	allowNetworkFetch: boolean
): Promise<number | null> {
	let totalBeforeSelected = 0;
	let foundSelected = false;
	for (const row of numberingRows) {
		const normalizedSources = normalizeSeasonSourcesForEpisodes(row.sources);
		const rowKey = row.seasonRowKey ?? '';
		if (rowKey == selectedSeasonRowKey) {
			foundSelected = true;
			break;
		}
		const count = await countRenderedNonSpecialEpisodesForSeasonSources(
			normalizedSources,
			seasonFetchCache,
			allowNetworkFetch
		);
		if (count == null) return null;
		totalBeforeSelected += count;
	}
	if (!foundSelected) return null;
	return Math.max(1, totalBeforeSelected + 1);
}
