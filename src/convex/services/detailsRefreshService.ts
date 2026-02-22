import type { ActionCtx } from '../_generated/server';
import type { MediaType } from '../types/mediaTypes';
import type {
	DetailRefreshDecision,
	PreparedDetailSync,
	RefreshCandidate,
	RefreshIfStaleArgs,
	RefreshIfStaleResult,
	StoredMediaSnapshot,
	SweepStaleDetailsResult
} from '../types/detailsType';
import type { MediaSource } from '../utils/mediaLookup';
import { internal } from '../_generated/api';
import {
	buildCompanies,
	buildCreatorCredits,
	computeIsAnime,
	computeNextRefreshAt,
	evaluateStoredMovieDecision,
	evaluateStoredTVDecision,
	shouldRetryDueToPotentialRegression,
	shouldRetryDueToSparseInitialPayload,
	toStoredEpisodeSummary
} from './detailsService';
import { fetchDetailsFromTMDB } from './detailsTmdbService';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_REFRESH_BACKOFF_MS = DAY_MS;
const BASE_REFRESH_BACKOFF_MS = 15 * MINUTE_MS;

export type DetailRefreshConfig = {
	detailSchemaVersion: number;
	leaseTtlMs: number;
	pruneLimit: number;
	scanPerType: number;
	maxRefreshes: number;
	batchSize: number;
	expediteRecheckMs: number;
};

export const DEFAULT_DETAIL_REFRESH_CONFIG = {
	leaseTtlMs: 90_000,
	pruneLimit: 200,
	scanPerType: 150,
	maxRefreshes: 36,
	batchSize: 6,
	expediteRecheckMs: HOUR_MS
} as const;

function createLeaseOwner(now: number): string {
	return `${now}:${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchPreparedDetailsForSync(
	mediaType: MediaType,
	id: number
): Promise<PreparedDetailSync> {
	const details = await fetchDetailsFromTMDB(mediaType, id);
	const companies = buildCompanies(details);
	const isAnime = computeIsAnime(details);
	const creatorCredits = buildCreatorCredits(details, isAnime, companies);
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

function evaluateDecision(
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

export async function runRefreshIfStale(
	ctx: ActionCtx,
	args: RefreshIfStaleArgs,
	config: Pick<DetailRefreshConfig, 'detailSchemaVersion' | 'leaseTtlMs' | 'expediteRecheckMs'>
): Promise<RefreshIfStaleResult> {
	const source = (args.source ?? 'tmdb') as MediaSource;
	if (source !== 'tmdb') {
		throw new Error(
			`Source '${source}' is not yet implemented. Currently only 'tmdb' is supported for details.`
		);
	}
	if (typeof args.id !== 'number') {
		throw new Error('TMDB IDs must be numbers');
	}

	const now = Date.now();
	const storedMedia: StoredMediaSnapshot | null = (await ctx.runQuery(internal.detailsRefresh.getStoredMedia, {
		mediaType: args.mediaType as MediaType,
		source,
		externalId: args.id
	})) as StoredMediaSnapshot | null;

	const decision = evaluateDecision(args, storedMedia, now, config.detailSchemaVersion);
	if (!decision.needsRefresh) {
		return {
			refreshed: false,
			reason: decision.reason,
			nextRefreshAt: storedMedia?.nextRefreshAt ?? null
		};
	}

	const leaseOwner = createLeaseOwner(now);
	const lease = await ctx.runMutation(internal.detailsRefresh.tryAcquireRefreshLease, {
		mediaType: args.mediaType as MediaType,
		source,
		externalId: args.id,
		now,
		ttlMs: config.leaseTtlMs,
		owner: leaseOwner
	});

	if (!lease.acquired || lease.leaseId === null) {
		return {
			refreshed: false,
			reason: 'in-flight',
			nextRefreshAt: storedMedia?.nextRefreshAt ?? null
		};
	}

	try {
		let effectiveStoredMedia = storedMedia;

		// Re-check staleness after acquiring lease to avoid duplicate fetches.
		if (args.force !== true) {
			const latestStored: StoredMediaSnapshot | null = (await ctx.runQuery(
				internal.detailsRefresh.getStoredMedia,
				{
					mediaType: args.mediaType as MediaType,
					source,
					externalId: args.id
				}
			)) as StoredMediaSnapshot | null;

			const latestDecision = evaluateDecision(
				{ ...args, force: false },
				latestStored,
				Date.now(),
				config.detailSchemaVersion
			);
			if (!latestDecision.needsRefresh) {
				return {
					refreshed: false,
					reason: latestDecision.reason,
					nextRefreshAt: latestStored?.nextRefreshAt ?? null
				};
			}

			effectiveStoredMedia = latestStored;
		}

		const mediaType = args.mediaType as MediaType;
		let prepared = await fetchPreparedDetailsForSync(mediaType, args.id);
		let shouldExpediteRecheck = false;
		const hasExistingDetailSnapshot =
			effectiveStoredMedia !== null &&
			effectiveStoredMedia.detailFetchedAt !== null &&
			effectiveStoredMedia.detailFetchedAt !== undefined;
		const shouldRetryPotentialRegression = shouldRetryDueToPotentialRegression(
			mediaType,
			effectiveStoredMedia,
			prepared
		);
		const shouldRetrySparseInitial =
			!hasExistingDetailSnapshot && shouldRetryDueToSparseInitialPayload(prepared);
		if (shouldRetryPotentialRegression || shouldRetrySparseInitial) {
			const retryPrepared = await fetchPreparedDetailsForSync(mediaType, args.id);
			const stillPotentialRegression =
				shouldRetryPotentialRegression &&
				shouldRetryDueToPotentialRegression(mediaType, effectiveStoredMedia, retryPrepared);
			const stillSparseInitial =
				shouldRetrySparseInitial && shouldRetryDueToSparseInitialPayload(retryPrepared);
			shouldExpediteRecheck = stillPotentialRegression || stillSparseInitial;
			prepared = retryPrepared;
		}

		const refreshedAt = Date.now();
		let nextRefreshAt = computeNextRefreshAt(prepared.details, refreshedAt);
		if (shouldExpediteRecheck) {
			nextRefreshAt = Math.min(nextRefreshAt, refreshedAt + config.expediteRecheckMs);
		}

		await ctx.runMutation(internal.detailsRefresh.insertMedia, {
			mediaType,
			source,
			externalId: args.id,
			title: prepared.details.title,
			posterPath: prepared.details.posterPath,
			backdropPath: prepared.details.backdropPath,
			releaseDate: prepared.details.releaseDate,
			overview: prepared.details.overview,
			status: prepared.details.status,
			runtime: prepared.details.mediaType === 'movie' ? prepared.details.runtime : null,
			numberOfSeasons:
				prepared.details.mediaType === 'tv' ? prepared.details.numberOfSeasons : undefined,
			lastAirDate: prepared.details.mediaType === 'tv' ? prepared.details.lastAirDate : null,
			lastEpisodeToAir:
				prepared.details.mediaType === 'tv'
					? toStoredEpisodeSummary(prepared.details.lastEpisodeToAir)
					: undefined,
			nextEpisodeToAir:
				prepared.details.mediaType === 'tv'
					? toStoredEpisodeSummary(prepared.details.nextEpisodeToAir)
					: undefined,
			detailSchemaVersion: config.detailSchemaVersion,
			detailFetchedAt: refreshedAt,
			nextRefreshAt,
			isAnime: prepared.isAnime,
			director: prepared.details.mediaType === 'movie' ? prepared.details.director : null,
			creator: prepared.details.mediaType === 'tv' ? prepared.details.creator : null,
			creatorCredits: prepared.creatorCredits
		});

		return {
			refreshed: true,
			reason: decision.reason,
			nextRefreshAt
		};
	} catch (error) {
		await ctx.runMutation(internal.detailsRefresh.recordRefreshFailure, {
			mediaType: args.mediaType as MediaType,
			source,
			externalId: args.id,
			failedAt: Date.now()
		});
		throw error;
	} finally {
		await ctx.runMutation(internal.detailsRefresh.releaseRefreshLease, {
			leaseId: lease.leaseId,
			owner: leaseOwner
		});
	}
}

export async function runSweepStaleDetails(
	ctx: ActionCtx,
	config: DetailRefreshConfig
): Promise<SweepStaleDetailsResult> {
	const now = Date.now();

	await ctx.runMutation(internal.detailsRefresh.pruneExpiredRefreshLeases, {
		now,
		limit: config.pruneLimit
	});

	const candidates = (await ctx.runQuery(internal.detailsRefresh.listStaleRefreshCandidates, {
		now,
		limitPerType: config.scanPerType
	})) as RefreshCandidate[];

	const selected = candidates.slice(0, config.maxRefreshes);
	let refreshed = 0;
	let skipped = 0;
	let failed = 0;

	for (let index = 0; index < selected.length; index += config.batchSize) {
		const batch = selected.slice(index, index + config.batchSize);
		const batchResults = await Promise.all(
			batch.map(async (candidate: RefreshCandidate) => {
				try {
					return await runRefreshIfStale(
						ctx,
						{
							mediaType: candidate.mediaType,
							id: candidate.id,
							source: 'tmdb',
							force: false
						},
						config
					);
				} catch {
					return null;
				}
			})
		);

		for (const result of batchResults) {
			if (result === null) {
				failed += 1;
				continue;
			}
			if (result.refreshed) {
				refreshed += 1;
			} else {
				skipped += 1;
			}
		}
	}

	return {
		scanned: candidates.length,
		selected: selected.length,
		refreshed,
		skipped,
		failed
	};
}
