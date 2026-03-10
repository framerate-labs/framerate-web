import type { Doc, Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import type { AniListRequestMetrics } from '../../types/anilistTypes';
import type { DisplaySeasonStatus } from '../../types/animeEpisodeTypes';
import type { AniListMediaCore, AnimeXrefRow } from '../../types/animeTypes';
import type { MediaType } from '../../types/mediaTypes';
import type { StoredAnimeRefreshSignals } from '../../utils/anime/sync';

import { internal } from '../../_generated/api';
import { daysSinceDate } from '../../utils/anime/dateUtils';
import { buildEpisodeBoundsBySeasonFromCacheRows } from '../../utils/anime/episodeUtils';
import { ANILIST_MEDIA_SCHEMA_VERSION } from '../../utils/anime/anilistMediaSchema';
import { animeTitleSyncLeaseKey, createAnimeSyncLeaseOwner } from '../../utils/anime/sync';
import {
	createAniListRequestMetrics,
	fetchAniListAnimeMediaById,
	searchAniListAnimeCandidates,
	summarizeAniListRateLimitHints
} from '../anilistService';
import { matchTMDBAnimeToAniListCandidates } from '../animeMatchService';
import { fetchTMDBAnimeSource } from '../animeTmdbService';

type EpisodeCacheRow = Doc<'animeEpisodeCache'>;

type AnimeSyncCoreArgs = {
	tmdbType: 'movie' | 'tv';
	tmdbId: number;
	forceNonAnime?: boolean;
	forceRematch?: boolean;
};

function summarizeAniListRunMetrics(aniListMetrics: AniListRequestMetrics) {
	return {
		aniListRequestAttempts: aniListMetrics.requestAttempts,
		aniListRateLimitedResponses: aniListMetrics.rateLimitedResponses,
		aniListRateLimitHints: summarizeAniListRateLimitHints(aniListMetrics) ?? undefined
	};
}

function dedupeById<T extends { id: number }>(rows: T[]): T[] {
	return Array.from(new Map(rows.map((row) => [row.id, row])).values());
}

function toCachePayload(media: AniListMediaCore) {
	return {
		anilistId: media.id,
		title: {
			romaji: media.title.romaji ?? null,
			english: media.title.english ?? null,
			native: media.title.native ?? null
		},
		format: media.format ?? undefined,
		startDate: media.startDate
			? {
					year: media.startDate.year ?? null,
					month: media.startDate.month ?? null,
					day: media.startDate.day ?? null
				}
			: undefined,
		seasonYear: media.seasonYear ?? undefined,
		episodes: media.episodes ?? undefined,
		description: media.description ?? undefined,
		studios:
			media.studios && media.studios.length > 0
				? media.studios.map((studio) => ({
						anilistStudioId: studio.anilistStudioId,
						name: studio.name,
						isAnimationStudio: studio.isAnimationStudio,
						isMain: studio.isMain
					}))
				: undefined,
		characters: (media.characters ?? []).map((character) => ({
			anilistCharacterId: character.anilistCharacterId,
			name: character.name,
			imageUrl: character.imageUrl ?? null,
			role: character.role ?? null,
			voiceActor: character.voiceActor
				? {
						anilistStaffId: character.voiceActor.anilistStaffId,
						name: character.voiceActor.name,
						imageUrl: character.voiceActor.imageUrl ?? null
					}
				: null,
			order: character.order
		})),
		staff: (media.staff ?? []).map((staff) => ({
			anilistStaffId: staff.anilistStaffId,
			name: staff.name,
			imageUrl: staff.imageUrl ?? null,
			role: staff.role ?? null,
			department: staff.department ?? null,
			order: staff.order
		}))
	};
}

function buildSearchTerms(title: string, originalTitle: string): string[] {
	const terms = [originalTitle, title]
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(terms)];
}

function buildAutoDisplaySeasonRowsFromTMDBSource(
	source: Awaited<ReturnType<typeof fetchTMDBAnimeSource>>,
	episodeBoundsBySeason?: Map<number, { minEpisodeNumber: number; maxEpisodeNumber: number }>
): Array<{
	rowKey: string;
	label: string;
	sortOrder: number;
	rowType: 'main' | 'specials';
	seasonOrdinal: number | null;
	episodeNumberingMode: null;
	status: DisplaySeasonStatus;
	hidden?: boolean;
	sources: Array<{
		sourceKey: string;
		sequence: number;
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
		displayAsRegularEpisode?: boolean;
	}>;
}> {
	if (source.tmdbType !== 'tv') {
		return [];
	}

	const nonSpecials = source.seasons
		.filter((s) => s.seasonNumber > 0)
		.sort((a, b) => a.seasonNumber - b.seasonNumber);
	const latestSeasonNumber =
		nonSpecials.length > 0 ? nonSpecials[nonSpecials.length - 1]!.seasonNumber : null;
	const now = Date.now();
	const statusLower = (source.details.status ?? '').toLowerCase();
	const isEnded =
		statusLower.includes('ended') ||
		statusLower.includes('cancelled') ||
		statusLower.includes('canceled');
	const nextSeasonNumber =
		source.details.mediaType === 'tv'
			? (source.details.nextEpisodeToAir?.seasonNumber ?? null)
			: null;
	const lastSeasonNumber =
		source.details.mediaType === 'tv'
			? (source.details.lastEpisodeToAir?.seasonNumber ?? null)
			: null;
	const daysSinceLastEpisode =
		source.details.mediaType === 'tv'
			? daysSinceDate(now, source.details.lastEpisodeToAir?.airDate ?? null)
			: null;
	const isActivelyInProduction =
		source.details.mediaType === 'tv' ? source.details.inProduction === true : false;
	const statusSuggestsReturning =
		statusLower.includes('returning') ||
		statusLower.includes('planned') ||
		statusLower.includes('production');

	const rows: Array<{
		rowKey: string;
		label: string;
		sortOrder: number;
		rowType: 'main' | 'specials';
		seasonOrdinal: number | null;
		episodeNumberingMode: null;
		status: DisplaySeasonStatus;
		hidden?: boolean;
		sources: Array<{
			sourceKey: string;
			sequence: number;
			tmdbSeasonNumber: number;
			tmdbEpisodeStart: number | null;
			tmdbEpisodeEnd: number | null;
			displayAsRegularEpisode?: boolean;
		}>;
	}> = [];

	for (const season of nonSpecials) {
		let autoStatus: DisplaySeasonStatus = null;
		const episodeBounds = episodeBoundsBySeason?.get(season.seasonNumber) ?? null;
		const canBoundSeason = episodeBounds != null;
		if (latestSeasonNumber != null) {
			if (season.seasonNumber < latestSeasonNumber) {
				autoStatus = canBoundSeason ? 'closed' : null;
			} else if (season.seasonNumber === latestSeasonNumber) {
				if (isEnded) {
					autoStatus = canBoundSeason ? 'closed' : null;
				} else {
					const strongOpenSignal =
						nextSeasonNumber === latestSeasonNumber ||
						(lastSeasonNumber === latestSeasonNumber &&
							(daysSinceLastEpisode == null || daysSinceLastEpisode <= 120)) ||
						isActivelyInProduction ||
						statusSuggestsReturning;
					autoStatus = strongOpenSignal ? 'open' : null;
				}
			}
		}
		rows.push({
			rowKey: `tmdb:s${season.seasonNumber}`,
			label: season.name?.trim() || `Season ${season.seasonNumber}`,
			sortOrder: season.seasonNumber,
			rowType: 'main',
			seasonOrdinal: season.seasonNumber,
			episodeNumberingMode: null,
			status: autoStatus,
			sources: [
				{
					sourceKey: `tmdb:s${season.seasonNumber}:all`,
					sequence: 1,
					tmdbSeasonNumber: season.seasonNumber,
					tmdbEpisodeStart:
						autoStatus === 'closed' && canBoundSeason ? episodeBounds!.minEpisodeNumber : null,
					tmdbEpisodeEnd:
						autoStatus === 'closed' && canBoundSeason ? episodeBounds!.maxEpisodeNumber : null
				}
			]
		});
	}
	if ((source.specialEpisodes?.length ?? 0) > 0) {
		rows.push({
			rowKey: 'tmdb:s0',
			label: 'Specials',
			sortOrder: 10_000,
			rowType: 'specials',
			seasonOrdinal: null,
			episodeNumberingMode: null,
			status: null,
			sources: [
				{
					sourceKey: 'tmdb:s0:all',
					sequence: 1,
					tmdbSeasonNumber: 0,
					tmdbEpisodeStart: null,
					tmdbEpisodeEnd: null,
					displayAsRegularEpisode: false
				}
			]
		});
	}
	return rows;
}

async function runAnimeSyncForTMDB(
	ctx: ActionCtx,
	args: AnimeSyncCoreArgs,
	syncMode: 'season' | 'full'
) {
	const aniListMetrics = createAniListRequestMetrics();
	const source = await fetchTMDBAnimeSource(args.tmdbType as MediaType, args.tmdbId);
	const episodeBoundsBySeason =
		source.tmdbType === 'tv'
			? buildEpisodeBoundsBySeasonFromCacheRows(
					((await ctx.runQuery(internal.animeSeasons.getEpisodeCachesBySeasons, {
						requests: source.seasons.map((season) => ({
							tmdbId: source.tmdbId,
							seasonNumber: season.seasonNumber
						}))
					})) as EpisodeCacheRow[]) ?? []
				)
			: undefined;
	const storedEligibility = (await ctx.runQuery(
		internal.animeSync.getStoredAnimeEligibilityByTMDB,
		{
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId
		}
	)) as StoredAnimeRefreshSignals | null;
	const storedIsAnime = storedEligibility?.isAnime ?? null;
	const animeEligibilityCheck =
		storedIsAnime == null
			? 'db_missing_used_heuristic'
			: storedIsAnime === source.isLikelyAnime
				? 'agree'
				: storedEligibility?.isAnimeSource === 'manual'
					? 'manual_override_disagree'
					: 'auto_disagree';
	const shouldTreatAsAnime =
		args.forceNonAnime === true
			? true
			: storedIsAnime != null
				? storedIsAnime === true
				: source.isLikelyAnime;
	if (!shouldTreatAsAnime) {
		return {
			ok: false,
			status: 'skipped_non_anime',
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			syncMode,
			animeEligibilityCheck,
			...summarizeAniListRunMetrics(aniListMetrics)
		} as const;
	}

	const existingXref = (await ctx.runQuery(internal.animeSync.getXrefByTMDB, {
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId
	})) as AnimeXrefRow | null;

	let anchorAnilistId = existingXref?.anilistId ?? null;
	let matchMeta:
		| {
				confidence: number;
				candidates: { anilistId: number; score: number; why?: string }[];
				reason?: string;
		  }
		| undefined;

	if (existingXref?.locked !== true || anchorAnilistId === null || args.forceRematch === true) {
		const candidateRows: AniListMediaCore[] = [];
		for (const term of buildSearchTerms(source.title, source.originalTitle)) {
			const found = await searchAniListAnimeCandidates(term, 10, aniListMetrics);
			candidateRows.push(...found);
		}

		const dedupedCandidates = dedupeById(candidateRows);
		const match = matchTMDBAnimeToAniListCandidates(source, dedupedCandidates);
		matchMeta = {
			confidence: match.confidence,
			candidates: match.candidates,
			reason: match.reason
		};

		if (match.accepted && match.selected) {
			const write = (await ctx.runMutation(internal.animeSync.upsertAnimeXrefAuto, {
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				title: {
					tmdb: source.title,
					anilistEnglish: match.selected.title.english ?? null,
					anilistRomaji: match.selected.title.romaji ?? null
				},
				anilistId: match.selected.id,
				confidence: match.confidence,
				method: match.method,
				candidates: match.candidates
			})) as { row: AnimeXrefRow | null; skippedLocked: boolean };
			const row: AnimeXrefRow | null = write.row;
			anchorAnilistId = row?.anilistId ?? anchorAnilistId;
		}
	}

	if (anchorAnilistId === null) {
		const autoRows = buildAutoDisplaySeasonRowsFromTMDBSource(source, episodeBoundsBySeason);
		const displaySeasonWrite = await ctx.runMutation(
			internal.animeSync.replaceAnimeDisplaySeasonsAuto,
			{
				tmdbType: args.tmdbType,
				tmdbId: args.tmdbId,
				rows: autoRows
			}
		);
		if (args.tmdbType === 'tv') {
			await ctx.runMutation(
				internal.animeSeasons.reconcileAutoDisplaySeasonBoundsFromEpisodeCache,
				{
					tmdbId: args.tmdbId
				}
			);
		}
		return {
			ok: true,
			status: 'synced_tmdb_only',
			syncMode,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			anchorAnilistId: null,
			displaySeasonRowsStored: autoRows.length,
			displaySeasonWrite,
			match: matchMeta,
			animeEligibilityCheck,
			...summarizeAniListRunMetrics(aniListMetrics)
		} as const;
	}

		try {
			const anchorMedia = await fetchAniListAnimeMediaById(anchorAnilistId, aniListMetrics);
			await ctx.runMutation(internal.animeSync.upsertAniListMediaBatch, {
				items: [toCachePayload(anchorMedia)],
				schemaVersion: ANILIST_MEDIA_SCHEMA_VERSION
			});
		} catch (error) {
		console.warn('[anime] failed to cache AniList anchor media', {
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			anchorAnilistId,
			error
		});
	}

	const autoRows = buildAutoDisplaySeasonRowsFromTMDBSource(source, episodeBoundsBySeason);
	const displaySeasonWrite = await ctx.runMutation(
		internal.animeSync.replaceAnimeDisplaySeasonsAuto,
		{
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			rows: autoRows
		}
	);
	if (args.tmdbType === 'tv') {
		await ctx.runMutation(internal.animeSeasons.reconcileAutoDisplaySeasonBoundsFromEpisodeCache, {
			tmdbId: args.tmdbId
		});
	}

	return {
		ok: true,
		status: 'synced',
		syncMode,
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId,
		anchorAnilistId,
		displaySeasonRowsStored: autoRows.length,
		displaySeasonWrite,
		match: matchMeta,
		animeEligibilityCheck,
		...summarizeAniListRunMetrics(aniListMetrics)
	} as const;
}

export async function runAnimeSyncWithLease(
	ctx: ActionCtx,
	args: AnimeSyncCoreArgs,
	options: { jobType: 'season' | 'timeline'; syncMode: 'season' | 'full'; leaseTtlMs: number }
) {
	const now = Date.now();
	const leaseOwner = createAnimeSyncLeaseOwner(now);
	const lease = (await ctx.runMutation(internal.animeSync.tryAcquireAnimeLease, {
		leaseKey: animeTitleSyncLeaseKey(options.jobType, args.tmdbType, args.tmdbId),
		leaseKind: 'title_sync',
		jobType: options.jobType,
		tmdbType: args.tmdbType,
		tmdbId: args.tmdbId,
		now,
		ttlMs: options.leaseTtlMs,
		owner: leaseOwner
	})) as { acquired: boolean; leaseId: Id<'animeSyncLeases'> | null; leaseExpiresAt: number };

	if (!lease.acquired || lease.leaseId === null) {
		return {
			ok: true,
			status: 'skipped_busy',
			jobType: options.jobType,
			syncMode: options.syncMode,
			tmdbType: args.tmdbType,
			tmdbId: args.tmdbId,
			leaseExpiresAt: lease.leaseExpiresAt
		} as const;
	}

	try {
		const result = await runAnimeSyncForTMDB(ctx, args, options.syncMode);
		if (result.ok === true && result.status === 'synced') {
			try {
				await ctx.runMutation(internal.details.syncAnimeCreatorCreditsForTMDB, {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId
				});
			} catch (error) {
				console.warn('[anime] failed to sync anime creator credits onto detail row', {
					tmdbType: args.tmdbType,
					tmdbId: args.tmdbId,
					error
				});
			}
		}
		return result;
	} finally {
		await ctx.runMutation(internal.animeSync.releaseAnimeLease, {
			leaseId: lease.leaseId,
			owner: leaseOwner
		});
	}
}
