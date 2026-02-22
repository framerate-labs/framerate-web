import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import type { MediaType } from './types/mediaTypes';
import type { NormalizedMediaDetails } from './types/tmdb/detailsTypes';
import type {
	DetailRefreshDecision,
	EnrichmentCompanyInput,
	HeaderContributorInput,
	PreparedDetailSync,
	RefreshCandidate,
	RefreshIfStaleArgs,
	RefreshIfStaleResult,
	StoredEpisodeSummary,
	StoredMediaSnapshot,
	StoredMovieDoc,
	StoredTVDoc,
	SweepStaleDetailsResult,
	SyncPolicy
} from './types/detailsTypes';
import type { MediaSource } from './utils/mediaLookup';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { fetchDetailsFromTMDB } from './services/detailsService';
import { getMovieBySource, getTVShowBySource } from './utils/mediaLookup';

// Argument validators
const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const DETAIL_SCHEMA_VERSION = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MAX_REFRESH_BACKOFF_MS = DAY_MS;
const BASE_REFRESH_BACKOFF_MS = 15 * MINUTE_MS;
const DETAIL_REFRESH_LEASE_TTL_MS = 90_000;
const DETAIL_REFRESH_LEASE_PRUNE_LIMIT = 200;
const DETAIL_SWEEPER_SCAN_PER_TYPE = 150;
const DETAIL_SWEEPER_MAX_REFRESHES = 36;
const DETAIL_SWEEPER_BATCH_SIZE = 6;

const MOVIE_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'db_authoritative',
	backdropPath: 'db_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	runtime: 'tmdb_authoritative',
	isAnime: 'db_authoritative',
	director: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const TV_SYNC_POLICY = {
	title: 'tmdb_authoritative',
	posterPath: 'db_authoritative',
	backdropPath: 'db_authoritative',
	releaseDate: 'tmdb_authoritative',
	overview: 'tmdb_authoritative',
	status: 'tmdb_authoritative',
	numberOfSeasons: 'tmdb_authoritative',
	lastAirDate: 'tmdb_authoritative',
	lastEpisodeToAir: 'tmdb_authoritative',
	nextEpisodeToAir: 'tmdb_authoritative',
	isAnime: 'db_authoritative',
	creator: 'tmdb_authoritative',
	creatorCredits: 'tmdb_authoritative'
} as const satisfies Record<string, SyncPolicy>;

const detailsEpisodeValidator = v.object({
	airDate: v.union(v.string(), v.null()),
	seasonNumber: v.number(),
	episodeNumber: v.number()
});

const detailCreatorCreditValidator = v.object({
	type: v.union(v.literal('person'), v.literal('company')),
	tmdbId: v.union(v.number(), v.null()),
	name: v.string(),
	role: v.union(v.string(), v.null())
});

function isMissingValue(value: unknown): boolean {
	return value === null || value === undefined;
}

function shouldApplySyncPolicy(
	policy: SyncPolicy,
	currentValue: unknown,
	incomingValue: unknown,
	options?: { treatUnknownAsMissing?: boolean }
): boolean {
	const currentIsUnknown =
		options?.treatUnknownAsMissing === true &&
		typeof currentValue === 'string' &&
		currentValue.trim().toLowerCase() === 'unknown';
	const currentMissing = isMissingValue(currentValue) || currentIsUnknown;
	const incomingMissing = isMissingValue(incomingValue);
	const incomingUndefined = incomingValue === undefined;

	switch (policy) {
		case 'tmdb_authoritative':
			// Undefined means "no incoming update". Null is a valid authoritative value.
			return !incomingUndefined && currentValue !== incomingValue;
		case 'fill_if_empty':
		case 'db_authoritative':
			return currentMissing && !incomingMissing;
		default:
			return false;
	}
}

function sameEpisodeSummary(
	left: StoredEpisodeSummary | null | undefined,
	right: StoredEpisodeSummary | null | undefined
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.airDate === right.airDate &&
		left.seasonNumber === right.seasonNumber &&
		left.episodeNumber === right.episodeNumber
	);
}

function sameHeaderContributor(
	left: HeaderContributorInput | null | undefined,
	right: HeaderContributorInput | null | undefined
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.type === right.type &&
		left.tmdbId === right.tmdbId &&
		left.name === right.name &&
		left.role === right.role
	);
}

function sameHeaderContributors(
	left: HeaderContributorInput[] | null | undefined,
	right: HeaderContributorInput[] | null | undefined
): boolean {
	const leftList = left ?? [];
	const rightList = right ?? [];
	if (leftList.length !== rightList.length) return false;
	for (let index = 0; index < leftList.length; index += 1) {
		if (!sameHeaderContributor(leftList[index], rightList[index])) {
			return false;
		}
	}
	return true;
}

function shouldRetryDueToPotentialRegression(
	mediaType: MediaType,
	stored: StoredMediaSnapshot | null,
	prepared: PreparedDetailSync
): boolean {
	if (stored === null) return false;

	if (stored.releaseDate !== null && stored.releaseDate !== undefined && prepared.details.releaseDate === null) {
		return true;
	}
	if (stored.overview !== null && stored.overview !== undefined && prepared.details.overview === null) {
		return true;
	}

	if (mediaType === 'movie' && prepared.details.mediaType === 'movie') {
		if (stored.runtime !== null && stored.runtime !== undefined && prepared.details.runtime === null) {
			return true;
		}
	} else if (mediaType === 'tv' && prepared.details.mediaType === 'tv') {
		if (
			stored.lastAirDate !== null &&
			stored.lastAirDate !== undefined &&
			prepared.details.lastAirDate === null
		) {
			return true;
		}
		if (
			stored.lastEpisodeToAir !== null &&
			stored.lastEpisodeToAir !== undefined &&
			prepared.details.lastEpisodeToAir === null
		) {
			return true;
		}
		if (
			stored.nextEpisodeToAir !== null &&
			stored.nextEpisodeToAir !== undefined &&
			prepared.details.nextEpisodeToAir === null
		) {
			return true;
		}
	}

	if ((stored.creatorCredits ?? []).length > 0 && prepared.creatorCredits.length === 0) {
		return true;
	}

	return false;
}

function shouldRetryDueToSparseInitialPayload(prepared: PreparedDetailSync): boolean {
	const missingOverview =
		prepared.details.overview === null || prepared.details.overview.trim().length === 0;
	const missingTitle = prepared.details.title.trim().length === 0;
	const missingCredits = prepared.creatorCredits.length === 0;
	return missingOverview && missingTitle && missingCredits;
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

function computeIsAnime(details: NormalizedMediaDetails): boolean {
	const hasAnimationGenre = details.genres.some(
		(genre) => genre.id === 16 || genre.name.toLowerCase() === 'animation'
	);
	const hasJapaneseLanguage =
		details.originalLanguage === 'ja' ||
		details.spokenLanguages.some((language) => language.iso6391 === 'ja') ||
		(details.mediaType === 'tv' && details.languages.includes('ja'));
	const hasJapaneseOrigin =
		details.originCountry.includes('JP') ||
		details.productionCountries.some((country) => country.iso31661 === 'JP');

	const score = [hasAnimationGenre, hasJapaneseLanguage, hasJapaneseOrigin].filter(Boolean).length;
	return score >= 2;
}

function dedupeCompanies(companies: EnrichmentCompanyInput[]): EnrichmentCompanyInput[] {
	const seen = new Set<number>();
	const unique: EnrichmentCompanyInput[] = [];
	for (const company of companies) {
		if (seen.has(company.tmdbId)) continue;
		seen.add(company.tmdbId);
		unique.push(company);
	}
	return unique;
}

function pickPrimaryStudio(
	companies: EnrichmentCompanyInput[],
	isAnime: boolean
): HeaderContributorInput | null {
	if (companies.length === 0) return null;

	if (isAnime) {
		const japanese = companies.find((company) => company.originCountry === 'JP');
		if (japanese) {
			return {
				type: 'company',
				tmdbId: japanese.tmdbId,
				name: japanese.name,
				role: 'studio'
			};
		}
	}

	const first = companies[0];
	if (!first) return null;
	return {
		type: 'company',
		tmdbId: first.tmdbId,
		name: first.name,
		role: 'studio'
	};
}

function buildCompanies(details: NormalizedMediaDetails): EnrichmentCompanyInput[] {
	return dedupeCompanies(
		details.productionCompanies.map((company, index) => ({
			tmdbId: company.id,
			name: company.name,
			logoPath: company.logoPath,
			originCountry: company.originCountry.trim() === '' ? null : company.originCountry,
			role: 'production',
			billingOrder: index
		}))
	);
}

function dedupeCreatorCredits(
	contributors: HeaderContributorInput[]
): HeaderContributorInput[] {
	const seen = new Set<string>();
	const unique: HeaderContributorInput[] = [];
	for (const contributor of contributors) {
		const normalizedName = contributor.name.trim();
		if (normalizedName.length === 0) continue;
		const key = `${contributor.type}:${contributor.tmdbId ?? normalizedName.toLowerCase()}:${contributor.role ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ ...contributor, name: normalizedName });
	}
	return unique;
}

function buildCreatorCredits(
	details: NormalizedMediaDetails,
	isAnime: boolean,
	companies: EnrichmentCompanyInput[]
): HeaderContributorInput[] {
	const primaryStudio = isAnime ? pickPrimaryStudio(companies, true) : null;

	if (details.mediaType === 'movie') {
		const directors = dedupeCreatorCredits(
			details.directorList.map((director) => ({
				type: 'person' as const,
				tmdbId: director.id,
				name: director.name,
				role: 'director'
			}))
		);
		const directorFallback =
			directors.length > 0
				? directors
				: dedupeCreatorCredits(
						details.director
							.split(',')
							.map((name) => name.trim())
							.filter((name) => name.length > 0)
							.map((name) => ({
								type: 'person' as const,
								tmdbId: null,
								name,
								role: 'director'
							}))
				  );

			if (isAnime && primaryStudio) {
				return dedupeCreatorCredits([
					primaryStudio,
					...directorFallback
				]);
			}

		return directorFallback;
	}

	if (isAnime && primaryStudio) {
		return [primaryStudio];
	}

	const creators = dedupeCreatorCredits(
		details.creatorList.map((creator) => ({
			type: 'person' as const,
			tmdbId: creator.id,
			name: creator.name,
			role: 'creator'
		}))
	);
	if (creators.length > 0) return creators;

	return dedupeCreatorCredits(
		details.creator
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name.length > 0)
			.map((name) => ({
				type: 'person' as const,
				tmdbId: null,
				name,
				role: 'creator'
			}))
	);
}

function cloneCreatorCredits(
	contributors: ReadonlyArray<{
		type: 'person' | 'company';
		tmdbId: number | null;
		name: string;
		role: string | null;
	}>
): HeaderContributorInput[] {
	return contributors.map((contributor) => ({
		type: contributor.type,
		tmdbId: contributor.tmdbId,
		name: contributor.name,
		role: contributor.role
	}));
}

function parseDate(dateString: string | null | undefined): Date | null {
	if (!dateString) return null;
	const parsed = new Date(dateString);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStatus(status: string | undefined): string {
	return (status ?? '').trim().toLowerCase();
}

function isEndedSeries(status: string | undefined): boolean {
	const normalized = normalizeStatus(status);
	return normalized === 'ended' || normalized === 'canceled' || normalized === 'cancelled';
}

function computeNextRefreshAt(details: NormalizedMediaDetails, now: number): number {
	if (details.mediaType === 'movie') {
		const releaseDate = parseDate(details.releaseDate);
		if (releaseDate === null) {
			// Missing release dates are uncommon but possible; keep modest cadence.
			return now + WEEK_MS;
		}

		const releaseTime = releaseDate.getTime();
		const inThirtyDays = now + 30 * DAY_MS;
		const thirtyDaysAgo = now - 30 * DAY_MS;

		if (releaseTime > inThirtyDays) {
			// Far-future release date.
			return now + WEEK_MS;
		}
		if (releaseTime >= thirtyDaysAgo) {
			// Releasing within 30 days or released within the last 30 days.
			return now + DAY_MS;
		}
		// Released more than 30 days ago.
		return now + 30 * DAY_MS;
	}

	if (isEndedSeries(details.status)) {
		return now + 30 * DAY_MS;
	}

	const nextAiring = parseDate(details.nextEpisodeToAir?.airDate ?? null);
	if (nextAiring !== null) {
		const delta = nextAiring.getTime() - now;
		if (delta <= 7 * DAY_MS) {
			return now + DAY_MS;
		}
		return now + WEEK_MS;
	}

	// Ongoing show without a known next air date.
	return now + WEEK_MS;
}

function toStoredEpisodeSummary(
	episode: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null
): StoredEpisodeSummary | null {
	if (!episode) return null;
	if (episode.seasonNumber <= 0 || episode.episodeNumber <= 0) return null;
	return {
		airDate: episode.airDate,
		seasonNumber: episode.seasonNumber,
		episodeNumber: episode.episodeNumber
	};
}

function computeErrorBackoffMs(errorCount: number): number {
	const exponent = Math.max(0, errorCount - 1);
	return Math.min(MAX_REFRESH_BACKOFF_MS, BASE_REFRESH_BACKOFF_MS * 2 ** exponent);
}

function createRefreshLeaseKey(mediaType: MediaType, source: MediaSource, externalId: number): string {
	return `${source}:${mediaType}:${externalId}`;
}

/**
 * Internal Query: Get stored media snapshot from DB.
 */
export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movie) return null;
			return {
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath,
				detailSchemaVersion: movie.detailSchemaVersion ?? null,
				detailFetchedAt: movie.detailFetchedAt ?? null,
				nextRefreshAt: movie.nextRefreshAt ?? null,
				releaseDate: movie.releaseDate ?? null,
					overview: movie.overview ?? null,
					status: movie.status ?? null,
					runtime: movie.runtime ?? null,
					director: movie.director ?? null,
					creatorCredits: movie.creatorCredits
				};
		}

		const tvShow = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShow) return null;
		return {
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
			detailFetchedAt: tvShow.detailFetchedAt ?? null,
			nextRefreshAt: tvShow.nextRefreshAt ?? null,
			releaseDate: tvShow.releaseDate ?? null,
			overview: tvShow.overview ?? null,
			status: tvShow.status ?? null,
				numberOfSeasons: tvShow.numberOfSeasons ?? null,
				lastAirDate: tvShow.lastAirDate ?? null,
				lastEpisodeToAir: tvShow.lastEpisodeToAir ?? null,
				nextEpisodeToAir: tvShow.nextEpisodeToAir ?? null,
				creator: tvShow.creator ?? null,
				creatorCredits: tvShow.creatorCredits
			};
	}
});

// One-time migration helper: patch legacy rows so required detail fields can be enforced safely.
export const backfillRequiredDetailFields = internalMutation({
	args: {
		limitPerTable: v.number(),
		table: v.optional(v.union(v.literal('movies'), v.literal('tvShows'))),
		cursor: v.optional(v.union(v.string(), v.null())),
		movieCursor: v.optional(v.union(v.string(), v.null())),
		tvShowCursor: v.optional(v.union(v.string(), v.null()))
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const table =
			args.table ?? ((args.tvShowCursor ?? null) !== null ? 'tvShows' : 'movies');
		const cursor =
			args.cursor ??
			(table === 'movies' ? (args.movieCursor ?? null) : (args.tvShowCursor ?? null));

		if (table === 'movies') {
			const page = await ctx.db.query('movies').order('asc').paginate({
				numItems: args.limitPerTable,
				cursor
			});
			let patched = 0;

			for (const movie of page.page) {
				const patch: {
					overview?: string | null;
					status?: string | null;
					runtime?: number | null;
					detailSchemaVersion?: number;
						detailFetchedAt?: number | null;
						nextRefreshAt?: number;
						refreshErrorCount?: number;
						lastRefreshErrorAt?: number | null;
						director?: string | null;
						creatorCredits?: HeaderContributorInput[];
					} = {};

				if (movie.overview === undefined) patch.overview = null;
				if (movie.status === undefined) patch.status = null;
				if (movie.runtime === undefined) patch.runtime = null;
				if (movie.detailSchemaVersion === undefined) patch.detailSchemaVersion = 0;
				if (movie.detailFetchedAt === undefined) patch.detailFetchedAt = null;
					if (movie.nextRefreshAt === undefined) patch.nextRefreshAt = now;
					if (movie.refreshErrorCount === undefined) patch.refreshErrorCount = 0;
					if (movie.lastRefreshErrorAt === undefined) patch.lastRefreshErrorAt = null;
					if (movie.director === undefined) patch.director = null;
					if (movie.creatorCredits === undefined) patch.creatorCredits = [];

				if (Object.keys(patch).length > 0) {
					await ctx.db.patch(movie._id, patch);
					patched += 1;
				}
			}

			const nextCursor = page.isDone ? null : page.continueCursor;
			return {
				table,
				scanned: page.page.length,
				patched,
				done: page.isDone,
				nextCursor,
				nextMovieCursor: nextCursor,
				nextTVShowCursor: null,
				moviesDone: page.isDone,
				tvShowsDone: false
			};
		}

		const page = await ctx.db.query('tvShows').order('asc').paginate({
			numItems: args.limitPerTable,
			cursor
		});
		let patched = 0;

		for (const tvShow of page.page) {
			const patch: {
				overview?: string | null;
				status?: string | null;
				numberOfSeasons?: number | null;
				lastAirDate?: string | null;
				lastEpisodeToAir?: StoredEpisodeSummary | null;
				nextEpisodeToAir?: StoredEpisodeSummary | null;
				detailSchemaVersion?: number;
					detailFetchedAt?: number | null;
					nextRefreshAt?: number;
					refreshErrorCount?: number;
					lastRefreshErrorAt?: number | null;
					creator?: string | null;
					creatorCredits?: HeaderContributorInput[];
				} = {};

			if (tvShow.overview === undefined) patch.overview = null;
			if (tvShow.status === undefined) patch.status = null;
			if (tvShow.numberOfSeasons === undefined) patch.numberOfSeasons = null;
			if (tvShow.lastAirDate === undefined) patch.lastAirDate = null;
			if (tvShow.lastEpisodeToAir === undefined) patch.lastEpisodeToAir = null;
			if (tvShow.nextEpisodeToAir === undefined) patch.nextEpisodeToAir = null;
			if (tvShow.detailSchemaVersion === undefined) patch.detailSchemaVersion = 0;
			if (tvShow.detailFetchedAt === undefined) patch.detailFetchedAt = null;
				if (tvShow.nextRefreshAt === undefined) patch.nextRefreshAt = now;
				if (tvShow.refreshErrorCount === undefined) patch.refreshErrorCount = 0;
				if (tvShow.lastRefreshErrorAt === undefined) patch.lastRefreshErrorAt = null;
				if (tvShow.creator === undefined) patch.creator = null;
				if (tvShow.creatorCredits === undefined) patch.creatorCredits = [];

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(tvShow._id, patch);
				patched += 1;
			}
		}

		const nextCursor = page.isDone ? null : page.continueCursor;
		return {
			table,
			scanned: page.page.length,
			patched,
			done: page.isDone,
			nextCursor,
			nextMovieCursor: null,
			nextTVShowCursor: nextCursor,
			moviesDone: false,
			tvShowsDone: page.isDone
		};
	}
});

/**
 * Internal Mutation: Upsert media details.
 */
export const insertMedia = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		overview: v.union(v.string(), v.null()),
		status: v.string(),
		runtime: v.union(v.number(), v.null()),
		numberOfSeasons: v.optional(v.number()),
		lastAirDate: v.union(v.string(), v.null()),
		lastEpisodeToAir: v.optional(v.union(detailsEpisodeValidator, v.null())),
		nextEpisodeToAir: v.optional(v.union(detailsEpisodeValidator, v.null())),
			detailSchemaVersion: v.number(),
			detailFetchedAt: v.number(),
			nextRefreshAt: v.number(),
			isAnime: v.boolean(),
			director: v.union(v.string(), v.null()),
			creator: v.union(v.string(), v.null()),
			creatorCredits: v.array(detailCreatorCreditValidator)
	},
	handler: async (ctx, args) => {
		const incomingCreatorCredits = dedupeCreatorCredits(
			cloneCreatorCredits(args.creatorCredits)
		);

		if (args.mediaType === 'movie') {
			const existing = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			let movieId: Id<'movies'>;

			if (!existing) {
				const movieData: {
					tmdbId?: number;
					traktId?: number;
					imdbId?: string;
					title: string;
					posterPath: string | null;
					backdropPath: string | null;
					releaseDate: string | null;
					detailSchemaVersion: number;
					detailFetchedAt: number;
						nextRefreshAt: number;
						refreshErrorCount: number;
						lastRefreshErrorAt: number | null;
						isAnime: boolean;
						director: string | null;
						creatorCredits: HeaderContributorInput[];
						overview: string | null;
					status: string;
					runtime: number | null;
				} = {
					title: args.title,
					posterPath: args.posterPath,
					backdropPath: args.backdropPath,
					releaseDate: args.releaseDate,
					detailSchemaVersion: args.detailSchemaVersion,
					detailFetchedAt: args.detailFetchedAt,
						nextRefreshAt: args.nextRefreshAt,
						refreshErrorCount: 0,
						lastRefreshErrorAt: null,
						isAnime: args.isAnime,
						director: args.director,
						creatorCredits: incomingCreatorCredits,
						overview: args.overview,
					status: args.status,
					runtime: args.runtime
				};

				if (args.source === 'tmdb') {
					movieData.tmdbId = args.externalId as number;
				} else if (args.source === 'trakt') {
					movieData.traktId = args.externalId as number;
				} else {
					movieData.imdbId = args.externalId as string;
				}

				movieId = await ctx.db.insert('movies', movieData);
			} else {
				movieId = existing._id;
				const patch: {
					title?: string;
					posterPath?: string | null;
					backdropPath?: string | null;
					releaseDate?: string | null;
					detailSchemaVersion?: number;
					detailFetchedAt?: number;
						nextRefreshAt?: number;
						refreshErrorCount?: number;
						lastRefreshErrorAt?: number | null;
						isAnime?: boolean;
						director?: string | null;
						creatorCredits?: HeaderContributorInput[];
						overview?: string | null;
					status?: string;
					runtime?: number | null;
				} = {};

				if (
					shouldApplySyncPolicy(MOVIE_SYNC_POLICY.title, existing.title, args.title)
				) {
					patch.title = args.title;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.posterPath,
						existing.posterPath,
						args.posterPath
					)
				) {
					patch.posterPath = args.posterPath;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.backdropPath,
						existing.backdropPath,
						args.backdropPath
					)
				) {
					patch.backdropPath = args.backdropPath;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.releaseDate,
						existing.releaseDate,
						args.releaseDate
					)
				) {
					patch.releaseDate = args.releaseDate;
				}
				if ((existing.detailSchemaVersion ?? 0) !== args.detailSchemaVersion) {
					patch.detailSchemaVersion = args.detailSchemaVersion;
				}
				if ((existing.detailFetchedAt ?? 0) !== args.detailFetchedAt) {
					patch.detailFetchedAt = args.detailFetchedAt;
				}
				if ((existing.nextRefreshAt ?? 0) !== args.nextRefreshAt) {
					patch.nextRefreshAt = args.nextRefreshAt;
				}
				if ((existing.refreshErrorCount ?? 0) !== 0) {
					patch.refreshErrorCount = 0;
				}
				if (existing.lastRefreshErrorAt === undefined) {
					patch.lastRefreshErrorAt = null;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.overview,
						existing.overview,
						args.overview
					)
				) {
					patch.overview = args.overview;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.status,
						existing.status ?? '',
						args.status
					)
				) {
					patch.status = args.status;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.runtime,
						existing.runtime ?? null,
						args.runtime
					)
				) {
					patch.runtime = args.runtime;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.isAnime,
						existing.isAnime,
						args.isAnime
					)
					) {
						patch.isAnime = args.isAnime;
					}
					if (
						shouldApplySyncPolicy(
							MOVIE_SYNC_POLICY.director,
						existing.director,
						args.director,
						{ treatUnknownAsMissing: true }
					)
				) {
					patch.director = args.director;
				}
				if (
					shouldApplySyncPolicy(
						MOVIE_SYNC_POLICY.creatorCredits,
						existing.creatorCredits ?? [],
						incomingCreatorCredits
					) &&
					!sameHeaderContributors(
						existing.creatorCredits ?? [],
						incomingCreatorCredits
					)
				) {
					patch.creatorCredits = incomingCreatorCredits;
				}

				if (Object.keys(patch).length > 0) {
					await ctx.db.patch(movieId, patch);
				}
			}

			return;
		}

		const existing = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		let tvShowId: Id<'tvShows'>;

		if (!existing) {
			const tvShowData: {
				tmdbId?: number;
				traktId?: number;
				imdbId?: string;
				title: string;
				posterPath: string | null;
				backdropPath: string | null;
				releaseDate: string | null;
				detailSchemaVersion: number;
				detailFetchedAt: number;
					nextRefreshAt: number;
					refreshErrorCount: number;
					lastRefreshErrorAt: number | null;
					isAnime: boolean;
					creator: string | null;
					creatorCredits: HeaderContributorInput[];
					overview: string | null;
				status: string;
				numberOfSeasons?: number | null;
				lastAirDate: string | null;
				lastEpisodeToAir?: StoredEpisodeSummary | null;
				nextEpisodeToAir?: StoredEpisodeSummary | null;
			} = {
				title: args.title,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				detailSchemaVersion: args.detailSchemaVersion,
				detailFetchedAt: args.detailFetchedAt,
				nextRefreshAt: args.nextRefreshAt,
				refreshErrorCount: 0,
				lastRefreshErrorAt: null,
				isAnime: args.isAnime,
				creator: args.creator,
				creatorCredits: incomingCreatorCredits,
				overview: args.overview,
				status: args.status,
				numberOfSeasons: args.numberOfSeasons,
				lastAirDate: args.lastAirDate,
				lastEpisodeToAir: args.lastEpisodeToAir,
				nextEpisodeToAir: args.nextEpisodeToAir
			};

			if (args.source === 'tmdb') {
				tvShowData.tmdbId = args.externalId as number;
			} else if (args.source === 'trakt') {
				tvShowData.traktId = args.externalId as number;
			} else {
				tvShowData.imdbId = args.externalId as string;
			}

			tvShowId = await ctx.db.insert('tvShows', tvShowData);
		} else {
			tvShowId = existing._id;
			const patch: {
				title?: string;
				posterPath?: string | null;
				backdropPath?: string | null;
				releaseDate?: string | null;
				detailSchemaVersion?: number;
				detailFetchedAt?: number;
				nextRefreshAt?: number;
				refreshErrorCount?: number;
				lastRefreshErrorAt?: number | null;
				isAnime?: boolean;
				creator?: string | null;
				creatorCredits?: HeaderContributorInput[];
				overview?: string | null;
				status?: string;
				numberOfSeasons?: number | null;
				lastAirDate?: string | null;
				lastEpisodeToAir?: StoredEpisodeSummary | null;
				nextEpisodeToAir?: StoredEpisodeSummary | null;
			} = {};

			if (
				shouldApplySyncPolicy(TV_SYNC_POLICY.title, existing.title, args.title)
			) {
				patch.title = args.title;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.posterPath,
					existing.posterPath,
					args.posterPath
				)
			) {
				patch.posterPath = args.posterPath;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.backdropPath,
					existing.backdropPath,
					args.backdropPath
				)
			) {
				patch.backdropPath = args.backdropPath;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.releaseDate,
					existing.releaseDate,
					args.releaseDate
				)
			) {
				patch.releaseDate = args.releaseDate;
			}
			if ((existing.detailSchemaVersion ?? 0) !== args.detailSchemaVersion) {
				patch.detailSchemaVersion = args.detailSchemaVersion;
			}
			if ((existing.detailFetchedAt ?? 0) !== args.detailFetchedAt) {
				patch.detailFetchedAt = args.detailFetchedAt;
			}
			if ((existing.nextRefreshAt ?? 0) !== args.nextRefreshAt) {
				patch.nextRefreshAt = args.nextRefreshAt;
			}
			if ((existing.refreshErrorCount ?? 0) !== 0) {
				patch.refreshErrorCount = 0;
			}
			if (existing.lastRefreshErrorAt === undefined) {
				patch.lastRefreshErrorAt = null;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.overview,
					existing.overview,
					args.overview
				)
			) {
				patch.overview = args.overview;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.status,
					existing.status ?? '',
					args.status
				)
			) {
				patch.status = args.status;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.numberOfSeasons,
					existing.numberOfSeasons,
					args.numberOfSeasons
				)
			) {
				patch.numberOfSeasons = args.numberOfSeasons;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.lastAirDate,
					existing.lastAirDate,
					args.lastAirDate
				)
			) {
				patch.lastAirDate = args.lastAirDate;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.lastEpisodeToAir,
					existing.lastEpisodeToAir,
					args.lastEpisodeToAir
				) &&
				!sameEpisodeSummary(existing.lastEpisodeToAir, args.lastEpisodeToAir)
			) {
				patch.lastEpisodeToAir = args.lastEpisodeToAir;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.nextEpisodeToAir,
					existing.nextEpisodeToAir,
					args.nextEpisodeToAir
				) &&
				!sameEpisodeSummary(existing.nextEpisodeToAir, args.nextEpisodeToAir)
			) {
				patch.nextEpisodeToAir = args.nextEpisodeToAir;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.isAnime,
					existing.isAnime,
					args.isAnime
				)
				) {
					patch.isAnime = args.isAnime;
				}
				if (
					shouldApplySyncPolicy(
						TV_SYNC_POLICY.creator,
					existing.creator,
					args.creator,
					{ treatUnknownAsMissing: true }
				)
			) {
				patch.creator = args.creator;
			}
			if (
				shouldApplySyncPolicy(
					TV_SYNC_POLICY.creatorCredits,
					existing.creatorCredits ?? [],
					incomingCreatorCredits
				) &&
				!sameHeaderContributors(
					existing.creatorCredits ?? [],
					incomingCreatorCredits
				)
			) {
				patch.creatorCredits = incomingCreatorCredits;
			}

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(tvShowId, patch);
			}
		}

	}
});

function evaluateStoredDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
	},
	now: number,
	hasTypeSpecificMissing: boolean
): DetailRefreshDecision {
	const hardMissing =
		(stored.detailSchemaVersion ?? 0) < DETAIL_SCHEMA_VERSION ||
		stored.detailFetchedAt === null ||
		stored.detailFetchedAt === undefined ||
		stored.overview === undefined ||
		stored.status === null ||
		stored.status === undefined ||
		hasTypeSpecificMissing;

	if (hardMissing) {
		return { needsRefresh: true, hardStale: true, reason: 'hard-stale' };
	}

	if ((stored.nextRefreshAt ?? 0) <= now) {
		return { needsRefresh: true, hardStale: false, reason: 'soft-stale' };
	}

	return { needsRefresh: false, hardStale: false, reason: 'fresh' };
}

function evaluateStoredMovieDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		runtime?: number | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing = stored.runtime === undefined || stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing);
}

function evaluateStoredTVDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		numberOfSeasons?: number | null;
		lastAirDate?: string | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing =
		stored.numberOfSeasons === null ||
		stored.numberOfSeasons === undefined ||
		stored.lastAirDate === undefined ||
		stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing);
}

export const tryAcquireRefreshLease = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.number(),
		now: v.number(),
		ttlMs: v.number(),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const refreshKey = createRefreshLeaseKey(
			args.mediaType as MediaType,
			args.source as MediaSource,
			args.externalId
		);
		const existing = await ctx.db
			.query('detailRefreshLeases')
			.withIndex('by_refreshKey', (q) => q.eq('refreshKey', refreshKey))
			.collect();
		const [activeLease, ...duplicateLeases] = existing;
		for (const duplicateLease of duplicateLeases) {
			await ctx.db.delete(duplicateLease._id);
		}
		const leaseExpiresAt = args.now + args.ttlMs;

		if (!activeLease) {
			const leaseId = await ctx.db.insert('detailRefreshLeases', {
				refreshKey,
				mediaType: args.mediaType as MediaType,
				source: args.source as MediaSource,
				externalId: args.externalId,
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return {
				acquired: true,
				leaseId,
				leaseExpiresAt
			};
		}

		if (activeLease.leaseExpiresAt <= args.now) {
			await ctx.db.patch(activeLease._id, {
				owner: args.owner,
				leasedAt: args.now,
				leaseExpiresAt
			});
			return {
				acquired: true,
				leaseId: activeLease._id,
				leaseExpiresAt
			};
		}

		return {
			acquired: false,
			leaseId: null,
			leaseExpiresAt: activeLease.leaseExpiresAt
		};
	}
});

export const releaseRefreshLease = internalMutation({
	args: {
		leaseId: v.id('detailRefreshLeases'),
		owner: v.string()
	},
	handler: async (ctx, args) => {
		const lease = await ctx.db.get(args.leaseId);
		if (!lease) return;
		if (lease.owner !== args.owner) return;
		await ctx.db.delete(args.leaseId);
	}
});

export const pruneExpiredRefreshLeases = internalMutation({
	args: {
		now: v.number(),
		limit: v.number()
	},
	handler: async (ctx, args) => {
		const expired = await ctx.db
			.query('detailRefreshLeases')
			.withIndex('by_leaseExpiresAt', (q) => q.lte('leaseExpiresAt', args.now))
			.take(args.limit);

		for (const lease of expired) {
			await ctx.db.delete(lease._id);
		}

		return { pruned: expired.length };
	}
});

export const listStaleRefreshCandidates = internalQuery({
	args: {
		now: v.number(),
		limitPerType: v.number()
	},
	handler: async (ctx, args): Promise<RefreshCandidate[]> => {
		const [movies, tvShows] = await Promise.all([
			ctx.db
				.query('movies')
				.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', args.now))
				.take(args.limitPerType),
			ctx.db
				.query('tvShows')
				.withIndex('by_nextRefreshAt', (q) => q.lte('nextRefreshAt', args.now))
				.take(args.limitPerType)
		]);

		const movieCandidates: RefreshCandidate[] = movies
			.filter((movie) => typeof movie.tmdbId === 'number')
			.map((movie) => ({
				mediaType: 'movie',
				id: movie.tmdbId as number,
				nextRefreshAt: movie.nextRefreshAt ?? 0
			}));

		const tvCandidates: RefreshCandidate[] = tvShows
			.filter((tvShow) => typeof tvShow.tmdbId === 'number')
			.map((tvShow) => ({
				mediaType: 'tv',
				id: tvShow.tmdbId as number,
				nextRefreshAt: tvShow.nextRefreshAt ?? 0
			}));

		return [...movieCandidates, ...tvCandidates].sort((a, b) => a.nextRefreshAt - b.nextRefreshAt);
	}
});

export const recordRefreshFailure = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		failedAt: v.number()
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = (await getMovieBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredMovieDoc | null;
			if (!movie) return;
			const nextErrorCount = (movie.refreshErrorCount ?? 0) + 1;
			const nextRefreshAt = args.failedAt + computeErrorBackoffMs(nextErrorCount);
			await ctx.db.patch(movie._id, {
				refreshErrorCount: nextErrorCount,
				lastRefreshErrorAt: args.failedAt,
				nextRefreshAt
			});
			return;
		}

		const tvShow = (await getTVShowBySource(
			ctx,
			args.source as MediaSource,
			args.externalId
		)) as StoredTVDoc | null;
		if (!tvShow) return;
		const nextErrorCount = (tvShow.refreshErrorCount ?? 0) + 1;
		const nextRefreshAt = args.failedAt + computeErrorBackoffMs(nextErrorCount);
		await ctx.db.patch(tvShow._id, {
			refreshErrorCount: nextErrorCount,
			lastRefreshErrorAt: args.failedAt,
			nextRefreshAt
		});
	}
});

function buildHeaderContext(
	credits: HeaderContributorInput[] | null | undefined,
	isAnime: boolean,
	defaultHeading: 'Directed by' | 'Created by'
): {
	heading: string;
	isAnime: boolean;
	contributors: HeaderContributorInput[];
} {
	const contributors = dedupeCreatorCredits(credits ?? []);
	const hasCompanyContributor = contributors.some((contributor) => contributor.type === 'company');
	return {
		heading: isAnime && hasCompanyContributor ? 'Animated by' : defaultHeading,
		isAnime,
		contributors
	};
}

export const getCached = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
		handler: async (ctx, args) => {
			const now = Date.now();
			if (args.mediaType === 'movie') {
				const movie = (await getMovieBySource(
					ctx,
					args.source as MediaSource,
					args.externalId
				)) as StoredMovieDoc | null;
				if (!movie || movie.tmdbId === undefined) return null;

				const headerContext = buildHeaderContext(movie.creatorCredits, movie.isAnime ?? false, 'Directed by');

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
				now
			);

			return {
				mediaType: 'movie' as const,
				id: movie.tmdbId,
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
				headerContext,
				nextRefreshAt: movie.nextRefreshAt ?? null,
				hardStale: refreshDecision.hardStale,
				isStale: refreshDecision.needsRefresh
			};
		}

			const tvShow = (await getTVShowBySource(
				ctx,
				args.source as MediaSource,
				args.externalId
			)) as StoredTVDoc | null;
			if (!tvShow || tvShow.tmdbId === undefined) return null;
			const headerContext = buildHeaderContext(tvShow.creatorCredits, tvShow.isAnime ?? false, 'Created by');

		const refreshDecision = evaluateStoredTVDecision(
			{
				detailSchemaVersion: tvShow.detailSchemaVersion ?? null,
				detailFetchedAt: tvShow.detailFetchedAt ?? null,
				nextRefreshAt: tvShow.nextRefreshAt ?? null,
				overview: tvShow.overview,
				status: tvShow.status ?? null,
				numberOfSeasons: tvShow.numberOfSeasons ?? null,
				lastAirDate: tvShow.lastAirDate ?? null,
				creatorCredits: tvShow.creatorCredits
			},
			now
		);

		return {
			mediaType: 'tv' as const,
			id: tvShow.tmdbId,
			title: tvShow.title,
			overview: tvShow.overview ?? null,
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			releaseDate: tvShow.releaseDate,
			movieRuntime: null,
			tvNumberOfSeasons: tvShow.numberOfSeasons ?? null,
			tvStatus: tvShow.status ?? null,
			tvLastAirDate: tvShow.lastAirDate ?? null,
			tvLastEpisodeToAir: tvShow.lastEpisodeToAir ?? null,
			tvNextEpisodeToAir: tvShow.nextEpisodeToAir ?? null,
			headerContext,
			nextRefreshAt: tvShow.nextRefreshAt ?? null,
			hardStale: refreshDecision.hardStale,
			isStale: refreshDecision.needsRefresh
		};
	}
});

async function refreshIfStaleHandler(
	ctx: ActionCtx,
	args: RefreshIfStaleArgs
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
	const storedMedia: StoredMediaSnapshot | null = (await ctx.runQuery(internal.details.getStoredMedia, {
		mediaType: args.mediaType as MediaType,
		source,
		externalId: args.id
	})) as StoredMediaSnapshot | null;

	let decision: DetailRefreshDecision;
	if (args.force === true) {
		decision = { needsRefresh: true, hardStale: true, reason: 'forced' };
	} else if (storedMedia === null) {
		decision = { needsRefresh: true, hardStale: true, reason: 'missing' };
	} else if (args.mediaType === 'movie') {
		decision = evaluateStoredMovieDecision(storedMedia, now);
	} else {
		decision = evaluateStoredTVDecision(storedMedia, now);
	}

	if (!decision.needsRefresh) {
		return {
			refreshed: false,
			reason: decision.reason,
			nextRefreshAt: storedMedia?.nextRefreshAt ?? null
		};
	}

	const leaseOwner = `${now}:${Math.random().toString(36).slice(2, 10)}`;
	const lease = await ctx.runMutation(internal.details.tryAcquireRefreshLease, {
		mediaType: args.mediaType as MediaType,
		source,
		externalId: args.id,
		now,
		ttlMs: DETAIL_REFRESH_LEASE_TTL_MS,
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
				internal.details.getStoredMedia,
				{
					mediaType: args.mediaType as MediaType,
					source,
					externalId: args.id
				}
			)) as StoredMediaSnapshot | null;

			let latestDecision: DetailRefreshDecision;
			if (latestStored === null) {
				latestDecision = { needsRefresh: true, hardStale: true, reason: 'missing' };
			} else if (args.mediaType === 'movie') {
				latestDecision = evaluateStoredMovieDecision(latestStored, Date.now());
			} else {
				latestDecision = evaluateStoredTVDecision(latestStored, Date.now());
			}

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
			nextRefreshAt = Math.min(nextRefreshAt, refreshedAt + HOUR_MS);
		}

		await ctx.runMutation(internal.details.insertMedia, {
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
				detailSchemaVersion: DETAIL_SCHEMA_VERSION,
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
		await ctx.runMutation(internal.details.recordRefreshFailure, {
			mediaType: args.mediaType as MediaType,
			source,
			externalId: args.id,
			failedAt: Date.now()
		});
		throw error;
	} finally {
		await ctx.runMutation(internal.details.releaseRefreshLease, {
			leaseId: lease.leaseId,
			owner: leaseOwner
		});
	}
}

export const refreshIfStale = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.union(v.number(), v.string()),
		source: v.optional(sourceValidator),
		force: v.optional(v.boolean())
	},
	handler: async (ctx, args): Promise<RefreshIfStaleResult> => {
		return await refreshIfStaleHandler(ctx, {
			mediaType: args.mediaType,
			id: args.id,
			source: args.source,
			force: args.force
		});
	}
});

export const sweepStaleDetails = internalAction({
	args: {},
	handler: async (ctx): Promise<SweepStaleDetailsResult> => {
		const now = Date.now();

		await ctx.runMutation(internal.details.pruneExpiredRefreshLeases, {
			now,
			limit: DETAIL_REFRESH_LEASE_PRUNE_LIMIT
		});

		const candidates = (await ctx.runQuery(internal.details.listStaleRefreshCandidates, {
			now,
			limitPerType: DETAIL_SWEEPER_SCAN_PER_TYPE
		})) as RefreshCandidate[];

		const selected = candidates.slice(0, DETAIL_SWEEPER_MAX_REFRESHES);
		let refreshed = 0;
		let skipped = 0;
		let failed = 0;

		for (let index = 0; index < selected.length; index += DETAIL_SWEEPER_BATCH_SIZE) {
			const batch = selected.slice(index, index + DETAIL_SWEEPER_BATCH_SIZE);
			const batchResults = await Promise.all(
				batch.map(async (candidate: RefreshCandidate) => {
					try {
						return await refreshIfStaleHandler(ctx, {
							mediaType: candidate.mediaType,
							id: candidate.id,
							source: 'tmdb',
							force: false
						});
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
});
