import type { TMDBAnimeSource, TMDBExternalIds } from '../types/animeTypes';
import type { MediaType } from '../types/mediaTypes';
import type { NormalizedMediaDetails } from '../types/tmdb/detailsTypes';

import { fetchTMDBJson } from '../utils/tmdb';
import { fetchDetailsFromTMDB } from './detailsTmdbService';

function parseYear(dateString: string | null | undefined): number | null {
	if (!dateString || dateString.length < 4) return null;
	const year = Number(dateString.slice(0, 4));
	return Number.isFinite(year) ? year : null;
}

function isLikelyAnime(details: NormalizedMediaDetails): boolean {
	const hasAnimationGenre = details.genres.some(
		(genre) => genre.id === 16 || genre.name.toLowerCase() === 'animation'
	);
	const hasJapaneseOriginalLanguage = details.originalLanguage === 'ja';
	const hasJapaneseOrigin = details.originCountry.includes('JP');
	return hasAnimationGenre && hasJapaneseOriginalLanguage && hasJapaneseOrigin;
}

function parseTMDBExternalIds(tmdbType: MediaType, raw: unknown): TMDBExternalIds {
	if (!raw || typeof raw !== 'object') {
		return { imdbId: null, tvdbId: null };
	}
	const row = raw as Record<string, unknown>;
	const imdbId =
		typeof row.imdb_id === 'string' && row.imdb_id.trim().length > 0 ? row.imdb_id : null;
	const tvdbId =
		tmdbType === 'tv' && typeof row.tvdb_id === 'number' && Number.isFinite(row.tvdb_id)
			? row.tvdb_id
			: null;
	return { imdbId, tvdbId };
}

export async function fetchTMDBAnimeSource(
	tmdbType: MediaType,
	tmdbId: number
): Promise<TMDBAnimeSource> {
	const details = await fetchDetailsFromTMDB(tmdbType, tmdbId);
	const externalIdsRaw = await fetchTMDBJson(`/${tmdbType}/${tmdbId}/external_ids`);
	const externalIds = parseTMDBExternalIds(tmdbType, externalIdsRaw);

	const seasons =
		details.mediaType === 'tv'
			? details.seasons.map((season) => ({
					seasonNumber: season.seasonNumber,
					name: season.name,
					episodeCount: season.episodeCount,
					airDate: season.airDate
				}))
			: [];

	const specialEpisodes =
		details.mediaType === 'tv'
			? await (async () => {
					try {
						const raw = (await fetchTMDBJson(`/tv/${tmdbId}/season/0`)) as Record<string, unknown>;
						const episodesRaw = Array.isArray(raw.episodes) ? raw.episodes : [];
						return episodesRaw
							.map(
								(
									episode
								): { episodeNumber: number; name: string; airDate: string | null } | null => {
									if (!episode || typeof episode !== 'object') return null;
									const row = episode as Record<string, unknown>;
									const episodeNumber = row.episode_number;
									if (typeof episodeNumber !== 'number' || !Number.isFinite(episodeNumber))
										return null;
									return {
										episodeNumber,
										name: typeof row.name === 'string' ? row.name : `Special ${episodeNumber}`,
										airDate: typeof row.air_date === 'string' ? row.air_date : null
									};
								}
							)
							.filter(
								(
									episode
								): episode is { episodeNumber: number; name: string; airDate: string | null } =>
									episode !== null
							);
					} catch {
						return [];
					}
				})()
			: [];

	return {
		tmdbType,
		tmdbId,
		title: details.title,
		originalTitle: details.originalTitle,
		releaseDate: details.releaseDate,
		releaseYear: parseYear(details.releaseDate),
		episodes: details.mediaType === 'tv' ? details.numberOfEpisodes : null,
		seasons,
		specialEpisodes,
		isLikelyAnime: isLikelyAnime(details),
		externalIds,
		details
	};
}
