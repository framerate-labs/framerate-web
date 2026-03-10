import type { AniListRateLimitHints, AniListRequestMetrics } from '../types/anilistTypes';
import type { AniListCharacter, AniListMediaCore, AniListStaff } from '../types/animeTypes';

import { anilistGraphQL } from '../utils/anime/client';
import {
	createAniListRequestMetrics,
	summarizeAniListRateLimitHints
} from '../utils/anime/metrics';
import { normalizeMediaCore } from '../utils/anime/normalizers';
import { MEDIA_BY_ID_QUERY, SEARCH_ANIME_QUERY } from '../utils/anime/queries';

export { createAniListRequestMetrics, summarizeAniListRateLimitHints };
export type { AniListRateLimitHints, AniListRequestMetrics };

const ANILIST_CONNECTION_PAGE_SIZE = 25;
const ANILIST_CONNECTION_MAX_PAGES = 8;
const ANILIST_PREVIEW_PAGE_SIZE = 10;

function readConnectionHasNextPage(media: unknown, connection: 'characters' | 'staff'): boolean {
	if (!media || typeof media !== 'object') return false;
	const connectionRow = (media as Record<string, unknown>)[connection];
	if (!connectionRow || typeof connectionRow !== 'object') return false;
	const pageInfo = (connectionRow as Record<string, unknown>).pageInfo;
	if (!pageInfo || typeof pageInfo !== 'object') return false;
	return (pageInfo as Record<string, unknown>).hasNextPage === true;
}

function dedupeByKey<T>(rows: T[], key: (row: T) => string): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const row of rows) {
		const rowKey = key(row);
		if (seen.has(rowKey)) continue;
		seen.add(rowKey);
		deduped.push(row);
	}
	return deduped;
}

function castCreditKey(row: AniListCharacter): string {
	const voiceActorId = row.voiceActor?.anilistStaffId ?? 'none';
	return `${row.anilistCharacterId}:${voiceActorId}:${row.role ?? ''}`;
}

function crewCreditKey(row: AniListStaff): string {
	return `${row.anilistStaffId}:${row.role ?? ''}:${row.department ?? ''}`;
}

export async function searchAniListAnimeCandidates(
	search: string,
	perPage = 10,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore[]> {
	const cleaned = search.trim();
	if (cleaned.length === 0) return [];

	const data = await anilistGraphQL<{
		Page?: {
			media?: unknown[];
		};
	}>(
		SEARCH_ANIME_QUERY,
		{
			search: cleaned,
			perPage
		},
		{ metrics, kind: 'search' }
	);

	const mediaRows = Array.isArray(data.Page?.media) ? data.Page?.media : [];
	const normalized: AniListMediaCore[] = [];
	for (const media of mediaRows ?? []) {
		const row = normalizeMediaCore(media);
		if (row) normalized.push(row);
	}
	return normalized;
}

export async function fetchAniListAnimeMediaById(
	id: number,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore> {
	let charactersPage = 1;
	let staffPage = 1;
	let hasNextCharactersPage = true;
	let hasNextStaffPage = true;

	let mergedMedia: AniListMediaCore | null = null;
	let mergedCharacters: AniListCharacter[] = [];
	let mergedStaff: AniListStaff[] = [];

	for (
		let page = 0;
		page < ANILIST_CONNECTION_MAX_PAGES && (hasNextCharactersPage || hasNextStaffPage);
		page += 1
	) {
		const data = await anilistGraphQL<{
			Media?: unknown;
		}>(
			MEDIA_BY_ID_QUERY,
			{
				id,
				charactersPage,
				staffPage,
				perPage: ANILIST_CONNECTION_PAGE_SIZE,
				includeCharacters: hasNextCharactersPage,
				includeStaff: hasNextStaffPage
			},
			{ metrics, kind: 'media' }
		);

		const media = normalizeMediaCore(data.Media);
		if (!media) {
			throw new Error(`AniList Media ${id} not found or invalid`);
		}
		if (!mergedMedia) {
			mergedMedia = {
				...media,
				characters: [],
				staff: []
			};
		}

		mergedCharacters.push(...(media.characters ?? []));
		mergedStaff.push(...(media.staff ?? []));

		hasNextCharactersPage = readConnectionHasNextPage(data.Media, 'characters');
		hasNextStaffPage = readConnectionHasNextPage(data.Media, 'staff');
		if (hasNextCharactersPage) charactersPage += 1;
		if (hasNextStaffPage) staffPage += 1;
	}

	if (!mergedMedia) {
		throw new Error(`AniList Media ${id} not found or invalid`);
	}

	const dedupedCharacters = dedupeByKey(mergedCharacters, castCreditKey).map((character, index) => ({
		...character,
		order: index
	}));
	const dedupedStaff = dedupeByKey(mergedStaff, crewCreditKey).map((staff, index) => ({
		...staff,
		order: index
	}));

	return {
		...mergedMedia,
		characters: dedupedCharacters,
		staff: dedupedStaff
	};
}

export async function fetchAniListAnimeMediaByIdPreview(
	id: number,
	metrics?: AniListRequestMetrics
): Promise<{
	media: AniListMediaCore;
	hasNextCharactersPage: boolean;
	hasNextStaffPage: boolean;
}> {
	const data = await anilistGraphQL<{
		Media?: unknown;
	}>(
		MEDIA_BY_ID_QUERY,
		{
			id,
			charactersPage: 1,
			staffPage: 1,
			perPage: ANILIST_PREVIEW_PAGE_SIZE,
			includeCharacters: true,
			includeStaff: true
		},
		{ metrics, kind: 'media' }
	);

	const media = normalizeMediaCore(data.Media);
	if (!media) {
		throw new Error(`AniList Media ${id} not found or invalid`);
	}

	return {
		media,
		hasNextCharactersPage: readConnectionHasNextPage(data.Media, 'characters'),
		hasNextStaffPage: readConnectionHasNextPage(data.Media, 'staff')
	};
}

export async function fetchAniListAnimeMediaGraphById(
	id: number,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore> {
	const data = await anilistGraphQL<{
		Media?: unknown;
	}>(
		MEDIA_BY_ID_QUERY,
		{
			id,
			charactersPage: 1,
			staffPage: 1,
			perPage: 1,
			includeCharacters: false,
			includeStaff: false
		},
		{ metrics, kind: 'media' }
	);

	const media = normalizeMediaCore(data.Media);
	if (!media) {
		throw new Error(`AniList Media ${id} not found or invalid`);
	}
	return media;
}
