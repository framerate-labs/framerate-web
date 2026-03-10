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
import type { AniListMediaRelation } from '../types/animeTypes';

import { internal } from '../_generated/api';
import {
	fetchAniListAnimeMediaById,
	fetchAniListAnimeMediaByIdPreview,
	fetchAniListAnimeMediaGraphById
} from './anilistService';
import { fetchCreditsFromTMDB } from './detailsTmdbService';
import {
	shouldRetryDueToPotentialRegression,
	shouldRetryDueToSparseInitialPayload
} from '../utils/details/animeEnrichment';
import {
	asPreviewRows,
	clampCreditRows,
	coverageRank,
	deriveCoverageFromPreviewTotals,
	toAniListCastCreditsFromMedia,
	toAniListCrewCreditsFromMedia
} from '../utils/details/credits';
import { computeNextRefreshAt, toStoredEpisodeSummary } from '../utils/details/refreshPolicy';
import {
	createLeaseOwner,
	ensureTMDBSource,
	evaluateDetailRefreshDecision,
	fetchPreparedDetailsForSync,
	mediaSourceFromArgs
} from '../utils/details/refreshRuntime';

type CreditSnapshot = {
	source: 'tmdb' | 'anilist';
	coverage: CreditCoverage;
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	castTotal: number;
	crewTotal: number;
};
type CreditSeasonContext = NonNullable<RefreshIfStaleArgs['creditSeasonContext']>;
type CreditCacheCoverageRow = { coverage: CreditCoverage; nextRefreshAt: number };
type AniListPreviewSnapshot = {
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	hasNextCharactersPage: boolean;
	hasNextStaffPage: boolean;
};
const ANILIST_SEASON_CHAIN_MAX_HOPS = 8;
const ANILIST_SEASON_MEMBER_IDS_MAX = 4;
const ANILIST_SEASON_ELIGIBLE_FORMATS = new Set(['TV', 'TV_SHORT', 'OVA', 'ONA']);

function resolveDesiredCoverage(target: CreditCoverage | undefined): CreditCoverage {
	return target === 'full' ? 'full' : 'preview';
}

function nextCreditRefreshAt(now: number, coverage: CreditCoverage): number {
	return coverage === 'full' ? now + 24 * 60 * 60_000 : now + 6 * 60 * 60_000;
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
	const seasonOrdinal =
		typeof seasonContext.seasonOrdinal === 'number' && Number.isFinite(seasonContext.seasonOrdinal)
			? Math.floor(seasonContext.seasonOrdinal)
			: null;
	const memberAnilistIds = Array.from(
		new Set(
			(seasonContext.memberAnilistIds ?? [])
				.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
				.map((value) => Math.floor(value))
				.filter((value) => value > 0)
		)
	).sort((left, right) => left - right);
	return {
		seasonKey,
		tmdbSeasonNumber,
		seasonOrdinal,
		memberAnilistIds
	};
}

function dedupeCreditsById<T extends { creditId: string }>(rows: T[]): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const row of rows) {
		if (seen.has(row.creditId)) continue;
		seen.add(row.creditId);
		deduped.push(row);
	}
	return deduped;
}

function reindexCastOrder(rows: StoredCastCredit[]): StoredCastCredit[] {
	return rows.map((row, index) => ({ ...row, order: index }));
}

function relationTimelineSortValue(relation: AniListMediaRelation): number {
	const startYear = relation.startDate?.year ?? relation.seasonYear ?? 0;
	const startMonth = relation.startDate?.month ?? 0;
	const startDay = relation.startDate?.day ?? 0;
	return startYear * 10_000 + startMonth * 100 + startDay;
}

function pickBestSequelRelation(
	relations: AniListMediaRelation[] | undefined,
	visitedIds: Set<number>
): number | null {
	const candidates = (relations ?? []).filter(
		(relation) =>
			relation.relationType === 'SEQUEL' &&
			(relation.type == null || relation.type === 'ANIME') &&
			(relation.format == null || ANILIST_SEASON_ELIGIBLE_FORMATS.has(relation.format)) &&
			relation.anilistId > 0 &&
			visitedIds.has(relation.anilistId) === false
	);
	if (candidates.length === 0) return null;
	candidates.sort((left, right) => {
		const leftTimeline = relationTimelineSortValue(left);
		const rightTimeline = relationTimelineSortValue(right);
		if (leftTimeline !== rightTimeline) return leftTimeline - rightTimeline;
		return left.anilistId - right.anilistId;
	});
	return candidates[0]?.anilistId ?? null;
}

function resolvePreferredCreditSource(args: {
	creditSourceOverride?: 'tmdb' | 'anilist';
}): 'tmdb' | 'anilist' {
	// Default all hot-path credit reads to TMDB.
	// AniList can be enriched asynchronously and becomes active once cached.
	return args.creditSourceOverride === 'anilist' ? 'anilist' : 'tmdb';
}

async function hasAniListXref(
	ctx: ActionCtx,
	args: { mediaType: MediaType; tmdbId: number }
): Promise<boolean> {
	const xrefRow = (await ctx.runQuery(internal.animeSync.getXrefByTMDB, {
		tmdbType: args.mediaType,
		tmdbId: args.tmdbId
	})) as { anilistId?: number | null } | null;
	return typeof xrefRow?.anilistId === 'number' && Number.isFinite(xrefRow.anilistId);
}

async function getCreditCoverage(
	ctx: ActionCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		source: 'tmdb' | 'anilist';
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

async function resolveAniListSeasonMediaIds(
	ctx: ActionCtx,
	args: { mediaType: MediaType; tmdbId: number; seasonContext: CreditSeasonContext | null }
): Promise<number[] | null> {
	if (args.mediaType === 'tv' && args.seasonContext != null) {
		const memberIds = (args.seasonContext.memberAnilistIds ?? [])
			.filter((value) => Number.isInteger(value) && value > 0)
			.slice(0, ANILIST_SEASON_MEMBER_IDS_MAX);
		// Treat any provided member list as authoritative for this display season.
		// This avoids false sequel-chain jumps (e.g. Naruto OG season rows mapping to Shippuden).
		if (memberIds.length > 0) return memberIds;
	}

	const xrefRow = (await ctx.runQuery(internal.animeSync.getXrefByTMDB, {
		tmdbType: args.mediaType,
		tmdbId: args.tmdbId
	})) as { anilistId?: number | null } | null;
	const rootAnilistId = xrefRow?.anilistId;
	if (typeof rootAnilistId !== 'number' || !Number.isFinite(rootAnilistId)) return null;

	if (args.mediaType !== 'tv' || args.seasonContext == null) {
		return [rootAnilistId];
	}

	const seasonOrdinal = args.seasonContext.seasonOrdinal ?? null;

	if (seasonOrdinal == null || seasonOrdinal <= 1) {
		return [rootAnilistId];
	}

	const chain: number[] = [rootAnilistId];
	const visited = new Set<number>(chain);
	let currentAnilistId = rootAnilistId;
	for (
		let hop = 0;
		hop < ANILIST_SEASON_CHAIN_MAX_HOPS && chain.length < seasonOrdinal;
		hop += 1
	) {
		const media = await fetchAniListAnimeMediaGraphById(currentAnilistId);
		const sequelId = pickBestSequelRelation(media.relations, visited);
		if (sequelId == null) break;
		chain.push(sequelId);
		visited.add(sequelId);
		currentAnilistId = sequelId;
	}

	const index = Math.max(0, Math.min(seasonOrdinal - 1, chain.length - 1));
	return [chain[index]!];
}

async function fetchAniListPreviewSnapshot(anilistId: number): Promise<AniListPreviewSnapshot> {
	const preview = await fetchAniListAnimeMediaByIdPreview(anilistId);
	return {
		castCredits: toAniListCastCreditsFromMedia(preview.media),
		crewCredits: toAniListCrewCreditsFromMedia(preview.media),
		hasNextCharactersPage: preview.hasNextCharactersPage,
		hasNextStaffPage: preview.hasNextStaffPage
	};
}

async function fetchAniListCreditSnapshot(
	ctx: ActionCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		desiredCoverage: CreditCoverage;
		seasonContext: CreditSeasonContext | null;
	}
): Promise<CreditSnapshot | null> {
	const anilistIds = await resolveAniListSeasonMediaIds(ctx, {
		mediaType: args.mediaType,
		tmdbId: args.tmdbId,
		seasonContext: args.seasonContext
	});
	if (!anilistIds || anilistIds.length === 0) return null;
	const scopedAnilistIds = anilistIds.slice(0, ANILIST_SEASON_MEMBER_IDS_MAX);

	if (args.desiredCoverage === 'full') {
		const mediaRows = await Promise.all(
			scopedAnilistIds.map((anilistId) => fetchAniListAnimeMediaById(anilistId))
		);
		const dedupedCastCredits = dedupeCreditsById(
			mediaRows.flatMap((media) => toAniListCastCreditsFromMedia(media))
		);
		const dedupedCrewCredits = dedupeCreditsById(
			mediaRows.flatMap((media) => toAniListCrewCreditsFromMedia(media))
		);
		const castTotal = dedupedCastCredits.length;
		const crewTotal = dedupedCrewCredits.length;
		const castCredits = reindexCastOrder(
			clampCreditRows(dedupedCastCredits)
		);
		const crewCredits = clampCreditRows(dedupedCrewCredits);
		return {
			source: 'anilist',
			coverage: 'full',
			castCredits,
			crewCredits,
			castTotal,
			crewTotal
		};
	}

	const previewRows = await Promise.all(
		scopedAnilistIds.map((anilistId) => fetchAniListPreviewSnapshot(anilistId))
	);
	const fullCastCredits = reindexCastOrder(
		dedupeCreditsById(previewRows.flatMap((row) => row.castCredits))
	);
	const fullCrewCredits = dedupeCreditsById(previewRows.flatMap((row) => row.crewCredits));
	const castTotal = fullCastCredits.length;
	const crewTotal = fullCrewCredits.length;
	const previewCoverage =
		previewRows.some((row) => row.hasNextCharactersPage || row.hasNextStaffPage)
			? ('preview' as const)
			: deriveCoverageFromPreviewTotals(castTotal, crewTotal);
	return {
		source: 'anilist',
		coverage: previewCoverage,
		castCredits:
			previewCoverage === 'full'
				? clampCreditRows(fullCastCredits)
				: asPreviewRows(clampCreditRows(fullCastCredits)),
		crewCredits:
			previewCoverage === 'full'
				? clampCreditRows(fullCrewCredits)
				: asPreviewRows(clampCreditRows(fullCrewCredits)),
		castTotal,
		crewTotal
	};
}

async function fetchCreditSnapshot(
	ctx: ActionCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		preferredSource: 'tmdb' | 'anilist';
		desiredCoverage: CreditCoverage;
		seasonContext: CreditSeasonContext | null;
		allowTMDBFallback: boolean;
	}
): Promise<CreditSnapshot | null> {
	if (args.preferredSource === 'anilist') {
		const aniListSnapshot = await fetchAniListCreditSnapshot(ctx, args);
		if (aniListSnapshot) return aniListSnapshot;
		if (!args.allowTMDBFallback) return null;
	}

	const tmdbCredits = await fetchCreditsFromTMDB(
		args.mediaType,
		args.tmdbId,
		args.desiredCoverage,
		{
			seasonNumber: args.seasonContext?.tmdbSeasonNumber ?? null
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
	const creditSourceOverride = args.creditSourceOverride;
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
	let hasAniListXrefCache: boolean | null = null;
	const checkAniListEnrichmentNeeded = async (isAnime: boolean, timestamp: number) => {
		if (!isAnime || creditSourceOverride === 'anilist') return false;
		if (hasAniListXrefCache == null) {
			hasAniListXrefCache = await hasAniListXref(ctx, { mediaType, tmdbId: args.id });
		}
		if (hasAniListXrefCache !== true) return false;
		const aniListCoverageState = await getCreditCoverage(ctx, {
			mediaType,
			tmdbId: args.id,
			source: 'anilist',
			now: timestamp,
			seasonContext: creditSeasonContext
		});
		return (
			aniListCoverageState.coverage === null ||
			aniListCoverageState.stale ||
			coverageRank(aniListCoverageState.coverage) < coverageRank('full')
		);
	};

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
	const initialPreferredCreditSource = resolvePreferredCreditSource({
		creditSourceOverride
	});
	const initialCreditState = await getCreditCoverage(ctx, {
		mediaType,
		tmdbId: args.id,
		source: initialPreferredCreditSource,
		now,
		seasonContext: creditSeasonContext
	});
	const initialCreditsNeedRefresh =
		args.force === true ||
		initialCreditState.coverage === null ||
		initialCreditState.stale ||
		coverageRank(initialCreditState.coverage) < coverageRank(desiredCoverage);

	const initialAniListEnrichmentNeeded = await checkAniListEnrichmentNeeded(
		storedMedia?.isAnime === true,
		now
	);

	if (!initialShouldRefreshDetails && !initialCreditsNeedRefresh && !initialAniListEnrichmentNeeded) {
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
		let shouldScheduleAniListEnrichment = initialAniListEnrichmentNeeded;

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
				const latestPreferredCreditSource = resolvePreferredCreditSource({
					creditSourceOverride
				});
				const latestCreditState = await getCreditCoverage(ctx, {
					mediaType,
					tmdbId: args.id,
					source: latestPreferredCreditSource,
					now: Date.now(),
					seasonContext: creditSeasonContext
				});
				const latestCreditsNeedRefresh =
					latestCreditState.coverage === null ||
					latestCreditState.stale ||
					coverageRank(latestCreditState.coverage) < coverageRank(desiredCoverage);
				const latestAniListEnrichmentNeeded = await checkAniListEnrichmentNeeded(
					latestStored?.isAnime === true,
					Date.now()
				);
				if (!latestCreditsNeedRefresh && !latestAniListEnrichmentNeeded) {
					return {
						refreshed: false,
						reason: latestDecision.reason,
						nextRefreshAt: latestStored?.nextRefreshAt ?? null
					};
				}
				shouldScheduleAniListEnrichment = latestAniListEnrichmentNeeded;
			}

			effectiveStoredMedia = latestStored;
			shouldRefreshDetails = latestShouldRefreshDetails;
		}

		let prepared = shouldRefreshDetails
			? await fetchPreparedDetailsForSync(mediaType, args.id, {
					includeCredits: false
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
					includeCredits: false
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
					: (effectiveStoredMedia?.creatorCredits ?? []);
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
				creatorCredits,
				castCredits: [],
				crewCredits: []
			});
		}

		const effectiveIsAnime = prepared?.isAnime ?? (effectiveStoredMedia?.isAnime === true);
		shouldScheduleAniListEnrichment = await checkAniListEnrichmentNeeded(
			effectiveIsAnime,
			Date.now()
		);

		const preferredCreditSource = resolvePreferredCreditSource({
			creditSourceOverride
		});
		const currentCreditState = await getCreditCoverage(ctx, {
			mediaType,
			tmdbId: args.id,
			source: preferredCreditSource,
			now: Date.now(),
			seasonContext: creditSeasonContext
		});
		const creditsNeedRefresh =
			args.force === true ||
			currentCreditState.coverage === null ||
			currentCreditState.stale ||
			coverageRank(currentCreditState.coverage) < coverageRank(desiredCoverage);

		let didRefreshCredits = false;
		if (creditsNeedRefresh) {
			const creditSnapshot = await fetchCreditSnapshot(ctx, {
				mediaType,
				tmdbId: args.id,
				preferredSource: preferredCreditSource,
				desiredCoverage,
				seasonContext: creditSeasonContext,
				allowTMDBFallback: preferredCreditSource !== 'anilist'
			});
			if (creditSnapshot != null) {
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
				if (creditSeasonContext == null) {
					await ctx.runMutation(internal.detailsRefresh.upsertStoredMediaCredits, {
						mediaType,
						tmdbId: args.id,
						castCredits: creditSnapshot.castCredits,
						crewCredits: creditSnapshot.crewCredits
					});
				}
				didRefreshCredits = true;
			}
		}

		if (shouldScheduleAniListEnrichment) {
			await ctx.scheduler.runAfter(0, internal.detailsRefresh.refreshAnimeCreditsInBackground, {
				mediaType,
				id: args.id,
				creditCoverageTarget: 'full',
				creditSeasonContext: creditSeasonContext ?? null
			});
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
