import type { DetailRefreshConfig } from '../../types/detailsRefreshTypes';
import type {
	DetailRefreshDecision,
	PreparedDetailSync,
	RefreshIfStaleArgs,
	StoredMediaSnapshot
} from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';
import type { MediaSource } from '../mediaLookup';

import { fetchDetailsFromTMDB } from '../../services/detailsTmdbService';
import { buildCompanies, buildCreatorCredits, computeIsAnime } from './animeEnrichment';
import { dedupeCreatorCredits } from './creatorCredits';
import { evaluateStoredMovieDecision, evaluateStoredTVDecision } from './refreshPolicy';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_REFRESH_BACKOFF_MS = DAY_MS;
const BASE_REFRESH_BACKOFF_MS = 15 * MINUTE_MS;

export const DEFAULT_DETAIL_REFRESH_CONFIG: Omit<DetailRefreshConfig, 'detailSchemaVersion'> = {
	leaseTtlMs: 90_000,
	pruneLimit: 200,
	scanPerType: 150,
	maxRefreshes: 36,
	batchSize: 6,
	expediteRecheckMs: HOUR_MS
} as const;

export function createLeaseOwner(now: number): string {
	return `${now}:${Math.random().toString(36).slice(2, 10)}`;
}

export async function fetchPreparedDetailsForSync(
	mediaType: MediaType,
	id: number,
	options?: { includeCredits?: boolean }
): Promise<PreparedDetailSync> {
	const details = await fetchDetailsFromTMDB(mediaType, id, {
		includeCredits: options?.includeCredits
	});
	const companies = buildCompanies(details);
	const isAnime = computeIsAnime(details);
	const creatorCredits = buildCreatorCredits(details, isAnime, companies, dedupeCreatorCredits);
	return {
		details,
		isAnime,
		creatorCredits
	};
}

export function createDetailRefreshLeaseKey(
	mediaType: MediaType,
	source: MediaSource,
	externalId: number
): string {
	return `${source}:${mediaType}:${externalId}`;
}

export function computeRefreshErrorBackoffMs(errorCount: number): number {
	const exponent = Math.max(0, errorCount - 1);
	return Math.min(MAX_REFRESH_BACKOFF_MS, BASE_REFRESH_BACKOFF_MS * 2 ** exponent);
}

export function evaluateDetailRefreshDecision(
	args: RefreshIfStaleArgs,
	storedMedia: StoredMediaSnapshot | null,
	now: number,
	detailSchemaVersion: number
): DetailRefreshDecision {
	if (args.force === true) {
		return { needsRefresh: true, hardStale: true, reason: 'forced' };
	}
	if (storedMedia === null) {
		return { needsRefresh: true, hardStale: true, reason: 'missing' };
	}
	if (args.mediaType === 'movie') {
		return evaluateStoredMovieDecision(storedMedia, now, detailSchemaVersion);
	}
	return evaluateStoredTVDecision(storedMedia, now, detailSchemaVersion);
}

export type DetailRefreshRuntimeConfig = Pick<
	DetailRefreshConfig,
	'detailSchemaVersion' | 'leaseTtlMs' | 'expediteRecheckMs'
>;

export type DetailRefreshSweepConfig = DetailRefreshConfig;

export function mediaSourceFromArgs(source: string | undefined): MediaSource {
	return (source ?? 'tmdb') as MediaSource;
}

export function ensureTMDBSource(source: MediaSource) {
	if (source !== 'tmdb') {
		throw new Error(
			`Source '${source}' is not yet implemented. Currently only 'tmdb' is supported for details.`
		);
	}
}
