import type { ActionCtx } from '../_generated/server';
import type { DetailRefreshConfig } from '../types/detailsRefreshTypes';
import type {
	CreditCoverage,
	RefreshCandidate,
	RefreshIfStaleArgs,
	RefreshIfStaleResult,
	StoredCastCredit,
	StoredCrewCredit,
	StoredMediaSnapshot,
	SweepStaleDetailsResult
} from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';

import { internal } from '../_generated/api';
import { fetchCreditsFromTMDB } from './detailsTmdbService';
import {
	shouldRetryDueToPotentialRegression,
	shouldRetryDueToSparseInitialPayload
} from '../utils/details/animeEnrichment';
import { clampCreditRows, coverageRank } from '../utils/details/credits';
import { computeNextRefreshAt, toStoredEpisodeSummary } from '../utils/details/refreshPolicy';
import {
	createLeaseOwner,
	ensureTMDBSource,
	evaluateDetailRefreshDecision,
	fetchPreparedDetailsForSync,
	mediaSourceFromArgs
} from '../utils/details/refreshRuntime';

type CreditSnapshot = {
	source: 'tmdb';
	coverage: CreditCoverage;
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	castTotal: number;
	crewTotal: number;
};
type CreditSeasonContext = NonNullable<RefreshIfStaleArgs['creditSeasonContext']>;
type CreditCacheCoverageRow = { coverage: CreditCoverage; nextRefreshAt: number };

function resolveDesiredCoverage(target: CreditCoverage | undefined): CreditCoverage {
	return target === 'full' ? 'full' : 'preview';
}

function nextCreditRefreshAt(now: number, coverage: CreditCoverage): number {
	return coverage === 'full' ? now + 24 * 60 * 60_000 : now + 6 * 60 * 60_000;
}

function sanitizeStoredCreatorCredits(
	credits: StoredMediaSnapshot['creatorCredits'] | undefined
) {
	return (credits ?? []).filter((credit) => credit.name.trim().toLowerCase() !== 'unknown');
}

function collectTVCreatorSeeds(
	credits: StoredMediaSnapshot['creatorCredits'] | undefined
): { id: number; name: string }[] {
	const seedById = new Map<number, string>();
	for (const credit of credits ?? []) {
		if (credit.type !== 'person') continue;
		const source = credit.source ?? 'tmdb';
		if (source !== 'tmdb') continue;
		const candidateId = credit.sourceId ?? credit.tmdbId ?? null;
		if (candidateId == null || !Number.isFinite(candidateId)) continue;
		const normalizedName = credit.name.trim();
		const existingName = seedById.get(candidateId) ?? '';
		if (existingName.length === 0 && normalizedName.length > 0) {
			seedById.set(candidateId, normalizedName);
			continue;
		}
		if (!seedById.has(candidateId)) {
			seedById.set(candidateId, normalizedName);
		}
	}
	return [...seedById.entries()].map(([id, name]) => ({ id, name }));
}

function normalizeCreditSeasonContext(
	seasonContext: RefreshIfStaleArgs['creditSeasonContext']
): CreditSeasonContext | null {
	if (!seasonContext) return null;
	const seasonKey = seasonContext.seasonKey.trim();
	if (seasonKey.length === 0) return null;
	const tmdbSeasonNumber =
		typeof seasonContext.tmdbSeasonNumber === 'number' &&
		Number.isFinite(seasonContext.tmdbSeasonNumber)
			? Math.floor(seasonContext.tmdbSeasonNumber)
			: null;
	return {
		seasonKey,
		tmdbSeasonNumber
	};
}

async function getCreditCoverage(
	ctx: ActionCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		source: 'tmdb';
		now: number;
		seasonContext: CreditSeasonContext | null;
	}
): Promise<{ coverage: CreditCoverage | null; stale: boolean }> {
	const row = (await ctx.runQuery(internal.detailsRefresh.getCreditCacheBySource, {
		mediaType: args.mediaType,
		tmdbId: args.tmdbId,
		source: args.source,
		seasonKey: args.seasonContext?.seasonKey ?? null
	})) as CreditCacheCoverageRow | null;
	if (!row) return { coverage: null, stale: true };
	return {
		coverage: row.coverage,
		stale: row.nextRefreshAt <= args.now
	};
}

async function fetchCreditSnapshot(
	args: {
		mediaType: MediaType;
		tmdbId: number;
		desiredCoverage: CreditCoverage;
		seasonContext: CreditSeasonContext | null;
		isAnime: boolean | null;
		tvCreatorSeeds: { id: number; name: string }[];
	}
): Promise<CreditSnapshot> {
	const tmdbCredits = await fetchCreditsFromTMDB(
		args.mediaType,
		args.tmdbId,
		args.desiredCoverage,
		{
			seasonNumber: args.seasonContext?.tmdbSeasonNumber ?? null,
			isAnime: args.isAnime,
			tvCreatorSeeds: args.tvCreatorSeeds
		}
	);
	return {
		source: 'tmdb',
		coverage: tmdbCredits.coverage,
		castCredits: clampCreditRows(tmdbCredits.cast as StoredCastCredit[]),
		crewCredits: clampCreditRows(tmdbCredits.crew as StoredCrewCredit[]),
		castTotal: tmdbCredits.castTotal,
		crewTotal: tmdbCredits.crewTotal
	};
}

function shouldRefreshDetailsForRun(args: {
	decisionNeedsRefresh: boolean;
	force: boolean;
	creditSeasonContext: CreditSeasonContext | null;
	skipDetailRefresh: boolean;
}): boolean {
	if (args.skipDetailRefresh) return false;
	return args.decisionNeedsRefresh || (args.force && args.creditSeasonContext == null);
}

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
	const desiredCoverage = resolveDesiredCoverage(args.creditCoverageTarget);
	const creditSeasonContext = normalizeCreditSeasonContext(args.creditSeasonContext);
	const skipDetailRefresh = args.skipDetailRefresh === true;
	const mediaType = args.mediaType as MediaType;

	const now = Date.now();
	const storedMedia: StoredMediaSnapshot | null = (await ctx.runQuery(
		internal.detailsRefresh.getStoredMedia,
		{
			mediaType,
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
	const initialShouldRefreshDetails = shouldRefreshDetailsForRun({
		decisionNeedsRefresh: decision.needsRefresh,
		force: args.force === true,
		creditSeasonContext,
		skipDetailRefresh
	});
	const initialCreditState = await getCreditCoverage(ctx, {
		mediaType,
		tmdbId: args.id,
		source: 'tmdb',
		now,
		seasonContext: creditSeasonContext
	});
	const initialCreditsNeedRefresh =
		args.force === true ||
		initialCreditState.coverage === null ||
		initialCreditState.stale ||
		coverageRank(initialCreditState.coverage) < coverageRank(desiredCoverage);

	if (!initialShouldRefreshDetails && !initialCreditsNeedRefresh) {
		return {
			refreshed: false,
			reason: decision.reason === 'fresh' ? 'fresh' : decision.reason,
			nextRefreshAt: storedMedia?.nextRefreshAt ?? null
		};
	}

	const leaseOwner = createLeaseOwner(now);
	const lease = await ctx.runMutation(internal.detailsRefresh.tryAcquireRefreshLease, {
		mediaType,
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
		let shouldRefreshDetails = initialShouldRefreshDetails;

		// Re-check staleness after acquiring lease to avoid duplicate fetches.
		if (args.force !== true) {
			const latestStored: StoredMediaSnapshot | null = (await ctx.runQuery(
				internal.detailsRefresh.getStoredMedia,
				{
					mediaType,
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
			const latestShouldRefreshDetails = shouldRefreshDetailsForRun({
				decisionNeedsRefresh: latestDecision.needsRefresh,
				force: false,
				creditSeasonContext,
				skipDetailRefresh
			});
			if (!latestShouldRefreshDetails) {
				const recheckNow = Date.now();
				const latestCreditState = await getCreditCoverage(ctx, {
					mediaType,
					tmdbId: args.id,
					source: 'tmdb',
					now: recheckNow,
					seasonContext: creditSeasonContext
				});
				const latestCreditsNeedRefresh =
					latestCreditState.coverage === null ||
					latestCreditState.stale ||
					coverageRank(latestCreditState.coverage) < coverageRank(desiredCoverage);
				if (!latestCreditsNeedRefresh) {
					return {
						refreshed: false,
						reason: latestDecision.reason,
						nextRefreshAt: latestStored?.nextRefreshAt ?? null
					};
				}
			}

			effectiveStoredMedia = latestStored;
			shouldRefreshDetails = latestShouldRefreshDetails;
		}

			let prepared = shouldRefreshDetails
				? await fetchPreparedDetailsForSync(mediaType, args.id, {
						includeCredits: mediaType === 'movie'
					})
				: null;
			let shouldExpediteRecheck = false;
			if (prepared !== null && desiredCoverage === 'full') {
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
					const retryPrepared = await fetchPreparedDetailsForSync(mediaType, args.id, {
						includeCredits: mediaType === 'movie'
					});
					const stillPotentialRegression =
						shouldRetryPotentialRegression &&
						shouldRetryDueToPotentialRegression(mediaType, effectiveStoredMedia, retryPrepared);
					const stillSparseInitial =
						shouldRetrySparseInitial && shouldRetryDueToSparseInitialPayload(retryPrepared);
					shouldExpediteRecheck = stillPotentialRegression || stillSparseInitial;
					prepared = retryPrepared;
				}
			}
			const refreshedAt = Date.now();
			let nextRefreshAt = effectiveStoredMedia?.nextRefreshAt ?? null;
			if (prepared !== null) {
				nextRefreshAt = computeNextRefreshAt(prepared.details, refreshedAt);
			}
			if (shouldExpediteRecheck) {
				nextRefreshAt = Math.min(
					nextRefreshAt ?? refreshedAt + config.expediteRecheckMs,
					refreshedAt + config.expediteRecheckMs
				);
			}
			if (prepared !== null) {
				const creatorCredits =
					prepared.creatorCredits.length > 0
						? prepared.creatorCredits
						: sanitizeStoredCreatorCredits(effectiveStoredMedia?.creatorCredits);
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
					seasons: prepared.details.mediaType === 'tv' ? prepared.details.seasons : undefined,
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
					nextRefreshAt: nextRefreshAt ?? refreshedAt,
					isAnime: prepared.isAnime,
					isAnimeSource: 'auto',
					creatorCredits
				});
			}

			const creditNow = Date.now();
			const currentCreditState = await getCreditCoverage(ctx, {
				mediaType,
				tmdbId: args.id,
				source: 'tmdb',
				now: creditNow,
				seasonContext: creditSeasonContext
			});
			const creditsNeedRefresh =
				args.force === true ||
				currentCreditState.coverage === null ||
				currentCreditState.stale ||
				coverageRank(currentCreditState.coverage) < coverageRank(desiredCoverage);

			let didRefreshCredits = false;
			if (creditsNeedRefresh) {
				const effectiveIsAnime =
					prepared?.isAnime ??
					(typeof effectiveStoredMedia?.isAnime === 'boolean' ? effectiveStoredMedia.isAnime : null);
				const effectiveCreatorCredits =
					prepared?.creatorCredits ??
					(typeof effectiveStoredMedia?.creatorCredits !== 'undefined'
						? effectiveStoredMedia.creatorCredits
						: undefined);
				const creditSnapshot = await fetchCreditSnapshot({
					mediaType,
					tmdbId: args.id,
					desiredCoverage,
					seasonContext: creditSeasonContext,
					isAnime: effectiveIsAnime,
					tvCreatorSeeds: collectTVCreatorSeeds(effectiveCreatorCredits)
				});
				await ctx.runMutation(internal.detailsRefresh.upsertCreditCache, {
					mediaType,
					tmdbId: args.id,
					source: creditSnapshot.source,
					seasonKey: creditSeasonContext?.seasonKey ?? null,
					coverage: creditSnapshot.coverage,
					castCredits: creditSnapshot.castCredits,
					crewCredits: creditSnapshot.crewCredits,
					castTotal: creditSnapshot.castTotal,
					crewTotal: creditSnapshot.crewTotal,
					fetchedAt: refreshedAt,
					nextRefreshAt: nextCreditRefreshAt(refreshedAt, creditSnapshot.coverage)
				});
				didRefreshCredits = true;
			}

		return {
			refreshed: shouldRefreshDetails || didRefreshCredits,
			reason: shouldRefreshDetails ? decision.reason : didRefreshCredits ? 'credits-refreshed' : 'fresh',
			nextRefreshAt: nextRefreshAt ?? null
		};
	} catch (error) {
		await ctx.runMutation(internal.detailsRefresh.recordRefreshFailure, {
			mediaType,
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
							force: false,
							creditCoverageTarget: 'full'
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
