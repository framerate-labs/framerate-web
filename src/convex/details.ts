import type {
	CreditCoverage,
	StoredCastCredit,
	StoredCrewCredit,
	StoredMovieDoc,
	StoredTVDoc
} from './types/detailsType';

import { v } from 'convex/values';

import { internalMutation, mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { resolveAnimeHeaderCredits } from './services/animeReadService';
import { resolveAnimeStudioStatus } from './utils/details/animeStudioStatus';
import {
	CREDIT_PREVIEW_LIMIT,
	creditCharacterKey,
	type CreditSource
} from './utils/details/credits';
import { mergeCreatorCreditsForSource } from './utils/details/creatorCredits';
import { buildHeaderContext, hasAniListStudioCredits } from './utils/details/headerContext';
import {
	clearMovieOverridesByTMDBId,
	clearTVOverridesByTMDBId,
	getCanonicalMovieOverrideAndCleanup,
	getCanonicalTVOverrideAndCleanup
} from './utils/details/overrideRows';
import {
	evaluateStoredMovieDecision,
	evaluateStoredTVDecision
} from './utils/details/refreshPolicy';
import {
	loadAnimeAiringDisplayContext,
	mapAnimeAiringEpisodeToDisplay
} from './utils/details/animeAiringDisplay';
import { sameHeaderContributors } from './utils/details/syncPolicy';
import {
	getFinalMovie,
	getFinalTV,
	getMovieBySource,
	getTVShowBySource
} from './utils/mediaLookup';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;
const creditCoverageValidator = v.union(v.literal('preview'), v.literal('full'));
const creditSourceValidator = v.union(v.literal('tmdb'), v.literal('anilist'));
const creditSeasonContextValidator = v.object({
	seasonKey: v.string(),
	tmdbSeasonNumber: v.optional(v.union(v.number(), v.null()))
});
const creditOverrideScopeValidator = v.union(
	v.literal('media_character'),
	v.literal('global_character')
);
const detailCreatorCreditValidator = v.object({
	type: v.union(v.literal('person'), v.literal('company')),
	tmdbId: v.union(v.number(), v.null()),
	name: v.string(),
	role: v.union(v.string(), v.null()),
	source: v.optional(v.union(v.literal('tmdb'), v.literal('anilist'))),
	sourceId: v.optional(v.union(v.number(), v.null())),
	matchMethod: v.optional(
		v.union(
			v.literal('exact'),
			v.literal('normalized'),
			v.literal('fuzzy'),
			v.literal('manual'),
			v.null()
		)
	),
	matchConfidence: v.optional(v.union(v.number(), v.null()))
});

function withDefined<T extends Record<string, unknown>>(values: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

function applyUnsetFields<T extends Record<string, unknown>>(
	values: Partial<T>,
	unsetFields: string[] | undefined
): Partial<T> {
	if (!unsetFields || unsetFields.length === 0) return values;
	const next = { ...values } as Partial<T>;
	for (const field of unsetFields) {
		(next as Record<string, unknown>)[field] = undefined;
	}
	return next;
}

type CreditOverridesRow = {
	scopeType: 'media_character' | 'global_character';
	source: CreditSource;
	characterKey: string;
	overrideCharacterName?: string | null;
	overrideImagePath?: string | null;
	updatedAt: number;
	seasonKey: string | null;
	_creationTime: number;
};

type ResolvedCreditsPayload = {
	cast: StoredCastCredit[];
	crew: StoredCrewCredit[];
	coverage: CreditCoverage | null;
	source: CreditSource;
	isExpired: boolean;
};

const PER_KEY_OVERRIDE_LOOKUP_THRESHOLD = 40;

function applyOverrideToCast(
	credit: StoredCastCredit,
	override: CreditOverridesRow | undefined
): StoredCastCredit {
	if (!override) return credit;
	const nextName = override.overrideCharacterName?.trim();
	const nextImagePath = override.overrideImagePath?.trim();
	return {
		...credit,
		name: nextName && nextName.length > 0 ? nextName : credit.name,
		originalName: nextName && nextName.length > 0 ? nextName : credit.originalName,
		profilePath: nextImagePath && nextImagePath.length > 0 ? nextImagePath : credit.profilePath
	};
}

function applyOverrideToCrew(
	credit: StoredCrewCredit,
	override: CreditOverridesRow | undefined
): StoredCrewCredit {
	if (!override) return credit;
	const nextName = override.overrideCharacterName?.trim();
	const nextImagePath = override.overrideImagePath?.trim();
	return {
		...credit,
		name: nextName && nextName.length > 0 ? nextName : credit.name,
		originalName: nextName && nextName.length > 0 ? nextName : credit.originalName,
		profilePath: nextImagePath && nextImagePath.length > 0 ? nextImagePath : credit.profilePath
	};
}

function pickLatestByUpdatedAt<T extends { updatedAt: number; _creationTime: number }>(
	rows: T[]
): T | null {
	if (rows.length === 0) return null;
	let latest = rows[0] ?? null;
	for (const row of rows) {
		if (latest == null) {
			latest = row;
			continue;
		}
		if (row.updatedAt > latest.updatedAt) {
			latest = row;
			continue;
		}
		if (row.updatedAt === latest.updatedAt && row._creationTime > latest._creationTime) {
			latest = row;
		}
	}
	return latest;
}

function normalizeSeasonKey(seasonKey: string | null | undefined): string | null {
	const trimmed = seasonKey?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

function seasonOverrideRank(rowSeasonKey: string | null, requestedSeasonKey: string | null): number {
	const normalizedRowSeasonKey = normalizeSeasonKey(rowSeasonKey);
	if (requestedSeasonKey == null) {
		return normalizedRowSeasonKey == null ? 1 : 0;
	}
	if (normalizedRowSeasonKey === requestedSeasonKey) return 2;
	if (normalizedRowSeasonKey == null) return 1;
	return 0;
}

function mapLatestOverridesForSeason(
	rows: CreditOverridesRow[],
	requestedSeasonKey: string | null
): Map<string, CreditOverridesRow> {
	const map = new Map<string, CreditOverridesRow>();
	for (const row of rows) {
		const rowRank = seasonOverrideRank(row.seasonKey ?? null, requestedSeasonKey);
		if (rowRank === 0) continue;
		const existing = map.get(row.characterKey);
		if (!existing) {
			map.set(row.characterKey, row);
			continue;
		}
		const existingRank = seasonOverrideRank(existing.seasonKey ?? null, requestedSeasonKey);
		if (rowRank > existingRank) {
			map.set(row.characterKey, row);
			continue;
		}
		if (rowRank === existingRank && row.updatedAt > existing.updatedAt) {
			map.set(row.characterKey, row);
			continue;
		}
		if (
			rowRank === existingRank &&
			row.updatedAt === existing.updatedAt &&
			row._creationTime > existing._creationTime
		) {
			map.set(row.characterKey, row);
		}
	}
	return map;
}

async function resolveCanonicalCreditCacheRow(
	ctx: QueryCtx,
	args: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		source: CreditSource;
		seasonKey?: string | null;
	}
) {
	const requestedSeasonKey = normalizeSeasonKey(args.seasonKey);
	return await ctx.db
		.query('creditCache')
		.withIndex('by_mediaType_tmdbId_source_seasonKey', (q) =>
			q
				.eq('mediaType', args.mediaType)
				.eq('tmdbId', args.tmdbId)
				.eq('source', args.source)
				.eq('seasonKey', requestedSeasonKey)
		)
		.unique();
}

async function resolveMediaOverrideMapForKeys(
	ctx: QueryCtx,
	args: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		source: CreditSource;
		keys: Set<string>;
		seasonKey?: string | null;
	}
): Promise<Map<string, CreditOverridesRow>> {
	if (args.keys.size === 0) return new Map();
	const keys = [...args.keys];
	const requestedSeasonKey = normalizeSeasonKey(args.seasonKey);

	const rows =
		keys.length <= PER_KEY_OVERRIDE_LOOKUP_THRESHOLD
			? (
					await Promise.all(
						keys.map((key) =>
							ctx.db
								.query('creditOverrides')
								.withIndex('by_mediaType_tmdbId_source_characterKey', (q) =>
									q
										.eq('mediaType', args.mediaType)
										.eq('tmdbId', args.tmdbId)
										.eq('source', args.source)
										.eq('characterKey', key)
								)
								.collect()
						)
					)
				).flat()
			: await ctx.db
					.query('creditOverrides')
					.withIndex('by_mediaType_tmdbId_source', (q) =>
						q.eq('mediaType', args.mediaType).eq('tmdbId', args.tmdbId).eq('source', args.source)
					)
					.collect();

	const filtered = rows.filter(
		(row) =>
			row.scopeType === 'media_character' &&
			args.keys.has(row.characterKey)
	) as CreditOverridesRow[];
	return mapLatestOverridesForSeason(filtered, requestedSeasonKey);
}

async function resolveGlobalOverrideMapForKeys(
	ctx: QueryCtx,
	args: {
		source: CreditSource;
		keys: Set<string>;
		seasonKey?: string | null;
	}
): Promise<Map<string, CreditOverridesRow>> {
	if (args.keys.size === 0) return new Map();
	const keys = [...args.keys];
	const requestedSeasonKey = normalizeSeasonKey(args.seasonKey);

	const rows =
		keys.length <= PER_KEY_OVERRIDE_LOOKUP_THRESHOLD
			? (
					await Promise.all(
						keys.map((key) =>
							ctx.db
								.query('creditOverrides')
								.withIndex('by_scopeType_source_characterKey', (q) =>
									q
										.eq('scopeType', 'global_character')
										.eq('source', args.source)
										.eq('characterKey', key)
								)
								.collect()
						)
					)
				).flat()
			: await ctx.db
					.query('creditOverrides')
					.withIndex('by_scopeType_source', (q) =>
						q.eq('scopeType', 'global_character').eq('source', args.source)
					)
					.collect();

	const filtered = rows.filter(
		(row) =>
			row.scopeType === 'global_character' &&
			args.keys.has(row.characterKey)
	) as CreditOverridesRow[];
	return mapLatestOverridesForSeason(filtered, requestedSeasonKey);
}

async function resolveCreditsPayload(
	ctx: QueryCtx,
	args: {
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		previewOnly: boolean;
		seasonKey?: string | null;
	}
): Promise<ResolvedCreditsPayload> {
	const requestedSeasonKey = normalizeSeasonKey(args.seasonKey);
	const source: CreditSource = 'tmdb';
	const scopedCacheRow = await resolveCanonicalCreditCacheRow(ctx, {
		mediaType: args.mediaType,
		tmdbId: args.tmdbId,
		source,
		seasonKey: requestedSeasonKey
	});
	const fallbackCacheRow =
		requestedSeasonKey != null && scopedCacheRow == null
			? await resolveCanonicalCreditCacheRow(ctx, {
					mediaType: args.mediaType,
					tmdbId: args.tmdbId,
					source,
					seasonKey: null
				})
			: null;
	const cacheRow = scopedCacheRow ?? fallbackCacheRow;
	const usedFallbackScope = requestedSeasonKey != null && scopedCacheRow == null && fallbackCacheRow != null;
	const baseCast = cacheRow?.castCredits ?? [];
	const baseCrew = cacheRow?.crewCredits ?? [];

	const limitedCast = args.previewOnly ? baseCast.slice(0, CREDIT_PREVIEW_LIMIT) : baseCast;
	const limitedCrew = args.previewOnly ? baseCrew.slice(0, CREDIT_PREVIEW_LIMIT) : baseCrew;
	const neededKeys = new Set<string>();
	for (const credit of limitedCast) {
		neededKeys.add(creditCharacterKey(source, credit.creditId));
	}
	for (const credit of limitedCrew) {
		neededKeys.add(creditCharacterKey(source, credit.creditId));
	}
	const [mediaMap, globalMap] = await Promise.all([
			resolveMediaOverrideMapForKeys(ctx, {
				mediaType: args.mediaType,
				tmdbId: args.tmdbId,
				source,
				keys: neededKeys,
				seasonKey: requestedSeasonKey
			}),
			resolveGlobalOverrideMapForKeys(ctx, {
				source,
				keys: neededKeys,
				seasonKey: requestedSeasonKey
			})
		]);

	const cast = limitedCast.map((credit) => {
		const key = creditCharacterKey(source, credit.creditId);
		const override = mediaMap.get(key) ?? globalMap.get(key);
		return applyOverrideToCast(credit, override);
	});
	const crew = limitedCrew.map((credit) => {
		const key = creditCharacterKey(source, credit.creditId);
		const override = mediaMap.get(key) ?? globalMap.get(key);
		return applyOverrideToCrew(credit, override);
	});

	return {
		cast,
		crew,
		coverage: usedFallbackScope ? null : (cacheRow?.coverage ?? null),
		source,
		isExpired: usedFallbackScope || (cacheRow != null && cacheRow.nextRefreshAt <= Date.now())
	};
}

export const syncAnimeCreatorCreditsForTMDB = internalMutation({
	args: {
		tmdbType: mediaTypeValidator,
		tmdbId: v.number()
	},
	handler: async (ctx, args) => {
		if (args.tmdbType === 'movie') {
			const movie = (await getMovieBySource(ctx, 'tmdb', args.tmdbId)) as StoredMovieDoc | null;
			if (!movie || movie.tmdbId === undefined)
				return { updated: false, reason: 'missing' as const };
			if (movie.isAnime !== true) return { updated: false, reason: 'not_anime' as const };
			const hadAniListStudioCredits = hasAniListStudioCredits(movie.creatorCredits);

			const animeCredits =
				(await resolveAnimeHeaderCredits(ctx, {
					tmdbType: 'movie',
					tmdbId: movie.tmdbId
				})) ?? [];
			if (animeCredits.length === 0) {
				return {
					updated: false,
					reason: hadAniListStudioCredits
						? ('preserved_existing_anilist' as const)
						: ('resolver_miss' as const)
				};
			}
			const mergedCreatorCredits = mergeCreatorCreditsForSource(
				movie.creatorCredits,
				animeCredits,
				'anilist'
			);
			if (sameHeaderContributors(movie.creatorCredits ?? [], mergedCreatorCredits)) {
				return { updated: false, reason: 'unchanged' as const };
			}

			await ctx.db.patch(movie._id, { creatorCredits: mergedCreatorCredits });
			return { updated: true, reason: 'patched' as const };
		}

		const tvShow = (await getTVShowBySource(ctx, 'tmdb', args.tmdbId)) as StoredTVDoc | null;
		if (!tvShow || tvShow.tmdbId === undefined)
			return { updated: false, reason: 'missing' as const };
		if (tvShow.isAnime !== true) return { updated: false, reason: 'not_anime' as const };
		const hadAniListStudioCredits = hasAniListStudioCredits(tvShow.creatorCredits);

		const animeCredits =
			(await resolveAnimeHeaderCredits(ctx, {
				tmdbType: 'tv',
				tmdbId: tvShow.tmdbId
			})) ?? [];
		if (animeCredits.length === 0) {
			return {
				updated: false,
				reason: hadAniListStudioCredits
					? ('preserved_existing_anilist' as const)
					: ('resolver_miss' as const)
			};
		}
		const mergedCreatorCredits = mergeCreatorCreditsForSource(
			tvShow.creatorCredits,
			animeCredits,
			'anilist'
		);
		if (sameHeaderContributors(tvShow.creatorCredits ?? [], mergedCreatorCredits)) {
			return { updated: false, reason: 'unchanged' as const };
		}

		await ctx.db.patch(tvShow._id, { creatorCredits: mergedCreatorCredits });
		return { updated: true, reason: 'patched' as const };
	}
});

export const get = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		if (args.mediaType === 'movie') {
			const movieBase = (await getMovieBySource(
				ctx,
				args.source,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movieBase || movieBase.tmdbId === undefined) return null;
			const movie = (await getFinalMovie(ctx, movieBase)) as StoredMovieDoc;
			const movieTmdbId = movie.tmdbId;
			if (movieTmdbId === undefined) return null;

			const isAnime = movie.isAnime ?? false;
			const animeStudioStatus = await resolveAnimeStudioStatus(
				ctx,
				'movie',
				movieTmdbId,
				movie.creatorCredits,
				isAnime
			);
			const headerContext = buildHeaderContext(
				movie.creatorCredits,
				isAnime,
				'movie',
				animeStudioStatus
			);

			const refreshDecision = evaluateStoredMovieDecision(
				{
					detailSchemaVersion: movie.detailSchemaVersion ?? null,
					detailFetchedAt: movie.detailFetchedAt ?? null,
					nextRefreshAt: movie.nextRefreshAt ?? null,
					overview: movie.overview,
					status: movie.status ?? null,
					runtime: movie.runtime,
					creatorCredits: movie.creatorCredits
				},
				now,
				DETAIL_SCHEMA_VERSION
			);
			return {
				mediaType: 'movie' as const,
				id: movieTmdbId,
				title: movie.title,
				overview: movie.overview ?? null,
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath,
				releaseDate: movie.releaseDate,
				movieRuntime: movie.runtime ?? null,
				tvNumberOfSeasons: null,
				tvStatus: null,
				tvLastAirDate: null,
				tvLastEpisodeToAir: null,
				tvNextEpisodeToAir: null,
				credits: {
					cast: [],
					crew: []
				},
				headerContext,
				nextRefreshAt: movie.nextRefreshAt ?? null,
				hardStale: refreshDecision.hardStale,
				isStale: refreshDecision.needsRefresh
			};
		}

		const tvShowBase = (await getTVShowBySource(
			ctx,
			args.source,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShowBase || tvShowBase.tmdbId === undefined) return null;
		const tvShow = (await getFinalTV(ctx, tvShowBase)) as StoredTVDoc;
		const tvShowTmdbId = tvShow.tmdbId;
		if (tvShowTmdbId === undefined) return null;

		const isAnime = tvShow.isAnime ?? false;
		const animeStudioStatus = await resolveAnimeStudioStatus(
			ctx,
			'tv',
			tvShowTmdbId,
			tvShow.creatorCredits,
			isAnime
		);
		const headerContext = buildHeaderContext(
			tvShow.creatorCredits,
			isAnime,
			'tv',
			animeStudioStatus
		);
		const animeAiringDisplayContext =
			isAnime && (tvShow.lastEpisodeToAir != null || tvShow.nextEpisodeToAir != null)
				? await loadAnimeAiringDisplayContext(ctx, {
						tmdbType: 'tv',
						tmdbId: tvShowTmdbId
					})
				: null;
		const mappedLastEpisodeToAir = mapAnimeAiringEpisodeToDisplay(
			animeAiringDisplayContext,
			tvShow.lastEpisodeToAir,
			{ prefersLatestOpenEndedRow: false }
		);
		const mappedNextEpisodeToAir = mapAnimeAiringEpisodeToDisplay(
			animeAiringDisplayContext,
			tvShow.nextEpisodeToAir,
			{ prefersLatestOpenEndedRow: true }
		);

		const refreshDecision = evaluateStoredTVDecision(
			{
				detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
				detailFetchedAt: tvShow.detailFetchedAt ?? null,
				nextRefreshAt: tvShow.nextRefreshAt ?? null,
				overview: tvShow.overview,
				status: tvShow.status ?? null,
				numberOfSeasons: tvShow.numberOfSeasons ?? null,
				seasons: tvShow.seasons,
				lastAirDate: tvShow.lastAirDate,
				lastEpisodeToAir: tvShow.lastEpisodeToAir,
				nextEpisodeToAir: tvShow.nextEpisodeToAir,
				creatorCredits: tvShow.creatorCredits
			},
			now,
			DETAIL_SCHEMA_VERSION
		);
		return {
			mediaType: 'tv' as const,
			id: tvShowTmdbId,
			title: tvShow.title,
			overview: tvShow.overview ?? null,
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			releaseDate: tvShow.releaseDate,
			movieRuntime: null,
			tvNumberOfSeasons: tvShow.numberOfSeasons ?? null,
			tvStatus: tvShow.status ?? null,
			tvLastAirDate: tvShow.lastAirDate ?? null,
			tvLastEpisodeToAir:
				tvShow.lastEpisodeToAir == null
					? null
					: {
							...tvShow.lastEpisodeToAir,
							displaySeasonNumber: mappedLastEpisodeToAir?.displaySeasonNumber ?? null,
							displayEpisodeNumber: mappedLastEpisodeToAir?.displayEpisodeNumber ?? null
						},
			tvNextEpisodeToAir:
				tvShow.nextEpisodeToAir == null
					? null
					: {
							...tvShow.nextEpisodeToAir,
							displaySeasonNumber: mappedNextEpisodeToAir?.displaySeasonNumber ?? null,
						displayEpisodeNumber: mappedNextEpisodeToAir?.displayEpisodeNumber ?? null
						},
			credits: {
				cast: [],
				crew: []
			},
			headerContext,
			nextRefreshAt: tvShow.nextRefreshAt ?? null,
			hardStale: refreshDecision.hardStale,
			isStale: refreshDecision.needsRefresh
		};
	}
});

export const getCredits = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		preferCoverage: v.optional(creditCoverageValidator),
		seasonContext: v.optional(v.union(creditSeasonContextValidator, v.null()))
	},
	handler: async (ctx, args) => {
		const preferredCoverage = args.preferCoverage ?? 'full';
		const seasonKey =
			args.mediaType === 'tv'
				? normalizeSeasonKey(args.seasonContext?.seasonKey ?? null)
				: null;
		if (args.mediaType === 'movie') {
			const movieBase = (await getMovieBySource(
				ctx,
				args.source,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movieBase || movieBase.tmdbId === undefined) return null;
			const movie = (await getFinalMovie(ctx, movieBase)) as StoredMovieDoc;
			const tmdbId = movie.tmdbId;
			if (tmdbId === undefined) return null;
			const resolved = await resolveCreditsPayload(ctx, {
				mediaType: 'movie',
				tmdbId,
				previewOnly: preferredCoverage === 'preview',
				seasonKey: null
			});
			return {
				cast: resolved.cast,
				crew: resolved.crew,
				coverage: resolved.coverage,
				source: resolved.source
			};
		}

		const tvShowBase = (await getTVShowBySource(
			ctx,
			args.source,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShowBase || tvShowBase.tmdbId === undefined) return null;
		const tvShow = (await getFinalTV(ctx, tvShowBase)) as StoredTVDoc;
		const tmdbId = tvShow.tmdbId;
		if (tmdbId === undefined) return null;
		const resolved = await resolveCreditsPayload(ctx, {
			mediaType: 'tv',
			tmdbId,
			previewOnly: preferredCoverage === 'preview',
			seasonKey
		});
		return {
			cast: resolved.cast,
			crew: resolved.crew,
			coverage: resolved.coverage,
			source: resolved.source
		};
	}
});

export const upsertCreditOverride = mutation({
	args: {
		scopeType: creditOverrideScopeValidator,
		source: creditSourceValidator,
		characterKey: v.string(),
		mediaType: v.optional(v.union(mediaTypeValidator, v.null())),
		tmdbId: v.optional(v.union(v.number(), v.null())),
		seasonKey: v.optional(v.union(v.string(), v.null())),
		overrideCharacterName: v.optional(v.union(v.string(), v.null())),
		overrideImagePath: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const normalizedScope = args.scopeType;
		const normalizedMediaType =
			normalizedScope === 'global_character' ? null : (args.mediaType ?? null);
		const normalizedTMDBId = normalizedScope === 'global_character' ? null : (args.tmdbId ?? null);
		const normalizedSeasonKey = normalizeSeasonKey(args.seasonKey);
		const now = Date.now();

		const rawCandidates =
			normalizedScope === 'global_character'
				? await ctx.db
						.query('creditOverrides')
						.withIndex('by_scopeType_source_characterKey', (q) =>
							q
								.eq('scopeType', 'global_character')
								.eq('source', args.source)
								.eq('characterKey', args.characterKey)
						)
						.collect()
				: await ctx.db
						.query('creditOverrides')
						.withIndex('by_mediaType_tmdbId_source_characterKey', (q) =>
							q
								.eq('mediaType', normalizedMediaType)
								.eq('tmdbId', normalizedTMDBId)
								.eq('source', args.source)
								.eq('characterKey', args.characterKey)
						)
						.collect();
		const candidates = rawCandidates.filter(
			(row) =>
				row.scopeType === normalizedScope && (row.seasonKey ?? null) === normalizedSeasonKey
		);
		const existing = pickLatestByUpdatedAt(candidates);

		const payload = {
			scopeType: normalizedScope,
			source: args.source,
			characterKey: args.characterKey,
			mediaType: normalizedMediaType,
			tmdbId: normalizedTMDBId,
			seasonKey: normalizedSeasonKey,
			overrideCharacterName: args.overrideCharacterName,
			overrideImagePath: args.overrideImagePath,
			updatedAt: now
		};

		if (existing) {
			await ctx.db.patch(existing._id, payload);
			for (const row of candidates) {
				if (row._id === existing._id) continue;
				await ctx.db.delete(row._id);
			}
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('creditOverrides', payload);
		return { ok: true, rowId };
	}
});

export const removeCreditOverride = mutation({
	args: {
		scopeType: creditOverrideScopeValidator,
		source: creditSourceValidator,
		characterKey: v.string(),
		mediaType: v.optional(v.union(mediaTypeValidator, v.null())),
		tmdbId: v.optional(v.union(v.number(), v.null())),
		seasonKey: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const normalizedScope = args.scopeType;
		const normalizedMediaType =
			normalizedScope === 'global_character' ? null : (args.mediaType ?? null);
		const normalizedTMDBId = normalizedScope === 'global_character' ? null : (args.tmdbId ?? null);
		const normalizedSeasonKey = normalizeSeasonKey(args.seasonKey);

		const candidates =
			normalizedScope === 'global_character'
				? await ctx.db
						.query('creditOverrides')
						.withIndex('by_scopeType_source_characterKey', (q) =>
							q
								.eq('scopeType', 'global_character')
								.eq('source', args.source)
								.eq('characterKey', args.characterKey)
						)
						.collect()
				: await ctx.db
						.query('creditOverrides')
						.withIndex('by_mediaType_tmdbId_source_characterKey', (q) =>
							q
								.eq('mediaType', normalizedMediaType)
								.eq('tmdbId', normalizedTMDBId)
								.eq('source', args.source)
								.eq('characterKey', args.characterKey)
						)
						.collect();

		let deleted = 0;
		for (const row of candidates) {
			if (
				row.scopeType !== normalizedScope ||
				(row.seasonKey ?? null) !== normalizedSeasonKey
			) {
				continue;
			}
			await ctx.db.delete(row._id);
			deleted += 1;
		}
		return { ok: true, deleted };
	}
});

export const updateMovieOverrides = mutation({
	args: {
		tmdbId: v.number(),
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		runtime: v.optional(v.union(v.number(), v.null())),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		unsetFields: v.optional(
			v.array(
				v.union(
					v.literal('title'),
					v.literal('isAnime'),
					v.literal('isAnimeSource'),
					v.literal('posterPath'),
					v.literal('backdropPath'),
					v.literal('releaseDate'),
					v.literal('overview'),
					v.literal('status'),
					v.literal('runtime'),
					v.literal('creatorCredits')
				)
			)
		)
	},
	handler: async (ctx, args) => {
		const existing = await getCanonicalMovieOverrideAndCleanup(ctx, args.tmdbId);
		const payload = applyUnsetFields(
			withDefined({
				title: args.title,
				isAnime: args.isAnime,
				isAnimeSource: args.isAnimeSource,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				overview: args.overview,
				status: args.status,
				runtime: args.runtime,
				creatorCredits: args.creatorCredits
			}),
			args.unsetFields
		);
		const updatedAt = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...payload, updatedAt });
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('movieOverrides', {
			tmdbId: args.tmdbId,
			...payload,
			updatedAt
		});
		return { ok: true, rowId };
	}
});

export const clearMovieOverrides = mutation({
	args: { tmdbId: v.number() },
	handler: async (ctx, args) => {
		const deleted = await clearMovieOverridesByTMDBId(ctx, args.tmdbId);
		return { ok: true, deleted };
	}
});

export const updateTVOverrides = mutation({
	args: {
		tmdbId: v.number(),
		title: v.optional(v.string()),
		isAnime: v.optional(v.boolean()),
		isAnimeSource: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
		posterPath: v.optional(v.union(v.string(), v.null())),
		backdropPath: v.optional(v.union(v.string(), v.null())),
		releaseDate: v.optional(v.union(v.string(), v.null())),
		overview: v.optional(v.union(v.string(), v.null())),
		status: v.optional(v.union(v.string(), v.null())),
		numberOfSeasons: v.optional(v.union(v.number(), v.null())),
		lastAirDate: v.optional(v.union(v.string(), v.null())),
		lastEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		nextEpisodeToAir: v.optional(
			v.union(
				v.object({
					airDate: v.union(v.string(), v.null()),
					seasonNumber: v.number(),
					episodeNumber: v.number()
				}),
				v.null()
			)
		),
		creatorCredits: v.optional(v.array(detailCreatorCreditValidator)),
		unsetFields: v.optional(
			v.array(
				v.union(
					v.literal('title'),
					v.literal('isAnime'),
					v.literal('isAnimeSource'),
					v.literal('posterPath'),
					v.literal('backdropPath'),
					v.literal('releaseDate'),
					v.literal('overview'),
					v.literal('status'),
					v.literal('numberOfSeasons'),
					v.literal('lastAirDate'),
					v.literal('lastEpisodeToAir'),
					v.literal('nextEpisodeToAir'),
					v.literal('creatorCredits')
				)
			)
		)
	},
	handler: async (ctx, args) => {
		const existing = await getCanonicalTVOverrideAndCleanup(ctx, args.tmdbId);
		const payload = applyUnsetFields(
			withDefined({
				title: args.title,
				isAnime: args.isAnime,
				isAnimeSource: args.isAnimeSource,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				overview: args.overview,
				status: args.status,
				numberOfSeasons: args.numberOfSeasons,
				lastAirDate: args.lastAirDate,
				lastEpisodeToAir: args.lastEpisodeToAir,
				nextEpisodeToAir: args.nextEpisodeToAir,
				creatorCredits: args.creatorCredits
			}),
			args.unsetFields
		);
		const updatedAt = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...payload, updatedAt });
			return { ok: true, rowId: existing._id };
		}
		const rowId = await ctx.db.insert('tvOverrides', {
			tmdbId: args.tmdbId,
			...payload,
			updatedAt
		});
		return { ok: true, rowId };
	}
});

export const clearTVOverrides = mutation({
	args: { tmdbId: v.number() },
	handler: async (ctx, args) => {
		const deleted = await clearTVOverridesByTMDBId(ctx, args.tmdbId);
		return { ok: true, deleted };
	}
});
