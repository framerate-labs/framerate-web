import type { ActionCtx } from '../_generated/server';
import type { DetailRefreshConfig } from '../types/detailsRefreshTypes';
import type {
	CreditCoverage,
	RefreshIfStaleArgs,
	RefreshIfStaleResult,
	StoredCastCredit,
	StoredCrewCredit,
	StoredMediaSnapshot
} from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';

import { internal } from '../_generated/api';
import {
	shouldRetryDueToPotentialRegression,
	shouldRetryDueToSparseInitialPayload
} from '../utils/details/animeEnrichment';
import { clampCreditRows, coverageRank } from '../utils/details/credits';
import { computeNextRefreshAt, toStoredEpisodeSummary } from '../utils/details/refreshPolicy';
import {
	ensureTMDBSource,
	evaluateDetailRefreshDecision,
	fetchPreparedDetailsForSync,
	mediaSourceFromArgs
} from '../utils/details/refreshRuntime';
import {
	buildCreditSnapshotFromNormalizedDetails,
	fetchCreditsFromTMDB
} from './detailsTmdbService';

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
type CreditSnapshotSource = {
	source: 'tmdb';
	coverage: CreditCoverage;
	cast: StoredCastCredit[];
	crew: StoredCrewCredit[];
	castTotal: number;
	crewTotal: number;
};

function resolveDesiredCoverage(target: CreditCoverage | undefined): CreditCoverage {
	return target === 'full' ? 'full' : 'preview';
}

function nextCreditRefreshAt(now: number, coverage: CreditCoverage): number {
	return coverage === 'full' ? now + 24 * 60 * 60_000 : now + 6 * 60 * 60_000;
}

function sanitizeStoredCreatorCredits(credits: StoredMediaSnapshot['creatorCredits'] | undefined) {
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

async function getDetailRefreshSnapshot(
	ctx: ActionCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		source: 'tmdb';
		now: number;
		seasonContext: CreditSeasonContext | null;
	}
): Promise<{
	storedMedia: StoredMediaSnapshot | null;
	creditCoverage: { coverage: CreditCoverage | null; stale: boolean };
}> {
	const snapshot = (await ctx.runQuery(internal.detailsRefresh.getDetailRefreshSnapshot, {
		mediaType: args.mediaType,
		source: args.source,
		externalId: args.tmdbId,
		creditSource: 'tmdb',
		seasonKey: args.seasonContext?.seasonKey ?? null
	})) as {
		storedMedia: StoredMediaSnapshot | null;
		creditCache: CreditCacheCoverageRow | null;
	};
	const row = snapshot.creditCache;
	if (!row) {
		return {
			storedMedia: snapshot.storedMedia,
			creditCoverage: { coverage: null, stale: true }
		};
	}
	return {
		storedMedia: snapshot.storedMedia,
		creditCoverage: {
			coverage: row.coverage,
			stale: row.nextRefreshAt <= args.now
		}
	};
}

async function fetchCreditSnapshot(args: {
	mediaType: MediaType;
	tmdbId: number;
	desiredCoverage: CreditCoverage;
	seasonContext: CreditSeasonContext | null;
	isAnime: boolean | null;
	tvCreatorSeeds: { id: number; name: string }[];
}): Promise<CreditSnapshot> {
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
	return toStoredCreditSnapshot({
		source: 'tmdb',
		coverage: tmdbCredits.coverage,
		cast: tmdbCredits.cast,
		crew: tmdbCredits.crew,
		castTotal: tmdbCredits.castTotal,
		crewTotal: tmdbCredits.crewTotal
	});
}

function toStoredCreditSnapshot(snapshot: CreditSnapshotSource): CreditSnapshot {
	return {
		source: snapshot.source,
		coverage: snapshot.coverage,
		castCredits: clampCreditRows(snapshot.cast),
		crewCredits: clampCreditRows(snapshot.crew),
		castTotal: snapshot.castTotal,
		crewTotal: snapshot.crewTotal
	};
}

function buildCreditSnapshotFromPreparedDetails(args: {
	preparedDetails: Parameters<typeof buildCreditSnapshotFromNormalizedDetails>[0];
	desiredCoverage: CreditCoverage;
	isAnime: boolean | null;
	tvCreatorSeeds: { id: number; name: string }[];
}): CreditSnapshot {
	const normalizedSnapshot = buildCreditSnapshotFromNormalizedDetails(
		args.preparedDetails,
		args.desiredCoverage,
		{
			isAnime: args.isAnime,
			tvCreatorSeeds: args.tvCreatorSeeds
		}
	);
	return toStoredCreditSnapshot({
		source: 'tmdb',
		coverage: normalizedSnapshot.coverage,
		cast: normalizedSnapshot.cast,
		crew: normalizedSnapshot.crew,
		castTotal: normalizedSnapshot.castTotal,
		crewTotal: normalizedSnapshot.crewTotal
	});
}

function creditCoverageNeedsRefresh(args: {
	creditState: { coverage: CreditCoverage | null; stale: boolean };
	desiredCoverage: CreditCoverage;
	force: boolean;
}): boolean {
	return (
		args.force ||
		args.creditState.coverage === null ||
		args.creditState.stale ||
		coverageRank(args.creditState.coverage) < coverageRank(args.desiredCoverage)
	);
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
	DEFAULT_DETAIL_REFRESH_CONFIG
} from '../utils/details/refreshRuntime';

export async function runRefreshIfStale(
	ctx: ActionCtx,
	args: RefreshIfStaleArgs,
	config: Pick<DetailRefreshConfig, 'detailSchemaVersion' | 'expediteRecheckMs'> & {
		skipExecutionRecheck?: boolean;
	}
): Promise<RefreshIfStaleResult> {
	const source = mediaSourceFromArgs(args.source);
	ensureTMDBSource(source);
	if (typeof args.id !== 'number') {
		throw new Error('TMDB IDs must be numbers');
	}
	const desiredCoverage = resolveDesiredCoverage(args.creditCoverageTarget);
	const creditSeasonContext = normalizeCreditSeasonContext(args.creditSeasonContext);
	const skipDetailRefresh = args.skipDetailRefresh === true;
	const mediaType: MediaType = args.mediaType;

	const now = Date.now();
	const initialSnapshot = await getDetailRefreshSnapshot(ctx, {
		mediaType,
		tmdbId: args.id,
		source: 'tmdb',
		now,
		seasonContext: creditSeasonContext
	});
	const storedMedia = initialSnapshot.storedMedia;

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
	const initialCreditState = initialSnapshot.creditCoverage;
	const initialCreditsNeedRefresh = creditCoverageNeedsRefresh({
		creditState: initialCreditState,
		desiredCoverage,
		force: args.force === true
	});

	if (!initialShouldRefreshDetails && !initialCreditsNeedRefresh) {
		return {
			refreshed: false,
			reason: decision.reason === 'fresh' ? 'fresh' : decision.reason,
			nextRefreshAt: storedMedia?.nextRefreshAt ?? null
		};
	}

	try {
		let effectiveStoredMedia = storedMedia;
		let shouldRefreshDetails = initialShouldRefreshDetails;
		let effectiveCreditState = initialCreditState;

		// For queue-authoritative worker execution, the queue claim already serializes
		// full detail refresh per title, so the extra recheck only adds read latency.
		// Keep it for direct credit refreshes and other non-queue paths.
		if (args.force !== true && config.skipExecutionRecheck !== true) {
			const recheckNow = Date.now();
			const latestSnapshot = await getDetailRefreshSnapshot(ctx, {
				mediaType,
				tmdbId: args.id,
				source: 'tmdb',
				now: recheckNow,
				seasonContext: creditSeasonContext
			});
			const latestStored = latestSnapshot.storedMedia;

			const latestDecision = evaluateDetailRefreshDecision(
				{ ...args, force: false },
				latestStored,
				recheckNow,
				config.detailSchemaVersion
			);
			const latestShouldRefreshDetails = shouldRefreshDetailsForRun({
				decisionNeedsRefresh: latestDecision.needsRefresh,
				force: false,
				creditSeasonContext,
				skipDetailRefresh
			});
			const latestCreditState = latestSnapshot.creditCoverage;
			if (!latestShouldRefreshDetails) {
				const latestCreditsNeedRefresh = creditCoverageNeedsRefresh({
					creditState: latestCreditState,
					desiredCoverage,
					force: false
				});
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
			effectiveCreditState = latestCreditState;
		}

		const creditsNeedRefresh = creditCoverageNeedsRefresh({
			creditState: effectiveCreditState,
			desiredCoverage,
			force: args.force === true
		});
		const shouldIncludeCreditsInPrepared =
			shouldRefreshDetails && creditsNeedRefresh && creditSeasonContext === null;

		let prepared = shouldRefreshDetails
			? await fetchPreparedDetailsForSync(mediaType, args.id, {
					includeCredits: shouldIncludeCreditsInPrepared
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
					includeCredits: shouldIncludeCreditsInPrepared
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
		const detailMutationArgs =
			prepared !== null
				? {
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
						isAnimeSource: 'auto' as const,
						creatorCredits:
							prepared.creatorCredits.length > 0
								? prepared.creatorCredits
								: sanitizeStoredCreatorCredits(effectiveStoredMedia?.creatorCredits)
					}
				: null;
		if (detailMutationArgs && !creditsNeedRefresh) {
			await ctx.runMutation(internal.detailsRefresh.insertMedia, detailMutationArgs);
		}

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
			const tvCreatorSeeds = collectTVCreatorSeeds(effectiveCreatorCredits);
			let creditSnapshot: CreditSnapshot;
			if (prepared !== null && shouldIncludeCreditsInPrepared && creditSeasonContext === null) {
				creditSnapshot = buildCreditSnapshotFromPreparedDetails({
					preparedDetails: prepared.details,
					desiredCoverage,
					isAnime: effectiveIsAnime,
					tvCreatorSeeds
				});
			} else {
				creditSnapshot = await fetchCreditSnapshot({
					mediaType,
					tmdbId: args.id,
					desiredCoverage,
					seasonContext: creditSeasonContext,
					isAnime: effectiveIsAnime,
					tvCreatorSeeds
				});
			}
			const creditCacheMutationArgs = {
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
			};
			if (detailMutationArgs) {
				await ctx.runMutation(internal.detailsRefresh.persistDetailRefreshArtifacts, {
					detail: detailMutationArgs,
					creditCache: creditCacheMutationArgs
				});
			} else {
				await ctx.runMutation(internal.detailsRefresh.upsertCreditCache, creditCacheMutationArgs);
			}
			didRefreshCredits = true;
		}

		let resultReason: RefreshIfStaleResult['reason'] = 'fresh';
		if (shouldRefreshDetails) {
			resultReason = decision.reason;
		} else if (didRefreshCredits) {
			resultReason = 'credits-refreshed';
		}
		const result = {
			refreshed: shouldRefreshDetails || didRefreshCredits,
			reason: resultReason,
			nextRefreshAt: nextRefreshAt ?? null
		};
		return result;
	} catch (error) {
		await ctx.runMutation(internal.detailsRefresh.recordRefreshFailure, {
			mediaType,
			source,
			externalId: args.id,
			failedAt: Date.now()
		});
		throw error;
	}
}
