import type { ActionCtx } from '../_generated/server';
import type { DetailRefreshConfig } from '../types/detailsRefreshTypes';
import type {
	RefreshCandidate,
	RefreshIfStaleArgs,
	RefreshIfStaleResult,
	StoredMediaSnapshot,
	SweepStaleDetailsResult
} from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';

import { internal } from '../_generated/api';
import {
	shouldRetryDueToPotentialRegression,
	shouldRetryDueToSparseInitialPayload
} from '../utils/details/animeEnrichment';
import { computeNextRefreshAt, toStoredEpisodeSummary } from '../utils/details/refreshPolicy';
import {
	createLeaseOwner,
	ensureTMDBSource,
	evaluateDetailRefreshDecision,
	fetchPreparedDetailsForSync,
	mediaSourceFromArgs
} from '../utils/details/refreshRuntime';

export {
	computeRefreshErrorBackoffMs,
	createDetailRefreshLeaseKey,
	DEFAULT_DETAIL_REFRESH_CONFIG
} from '../utils/details/refreshRuntime';

export async function runRefreshIfStale(
	ctx: ActionCtx,
	args: RefreshIfStaleArgs,
	config: Pick<DetailRefreshConfig, 'detailSchemaVersion' | 'leaseTtlMs' | 'expediteRecheckMs'>
): Promise<RefreshIfStaleResult> {
	const source = mediaSourceFromArgs(args.source);
	ensureTMDBSource(source);
	if (typeof args.id !== 'number') {
		throw new Error('TMDB IDs must be numbers');
	}

	const now = Date.now();
	const storedMedia: StoredMediaSnapshot | null = (await ctx.runQuery(
		internal.detailsRefresh.getStoredMedia,
		{
			mediaType: args.mediaType as MediaType,
			source,
			externalId: args.id
		}
	)) as StoredMediaSnapshot | null;

	const decision = evaluateDetailRefreshDecision(
		args,
		storedMedia,
		now,
		config.detailSchemaVersion
	);
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

			const latestDecision = evaluateDetailRefreshDecision(
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
			isAnimeSource: 'auto',
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
