import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import type {
	AnnotatedMediaWork,
	MediaLibraryState,
	MediaQueryContext,
	MediaWork,
	PersonMediaReference
} from './types/entitiesTypes';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import {
	annotateMediaWorksWithLibraryState,
	applyMediaWorkFilters,
	buildPersonMediaReferences,
	buildPersonMediaWorksFromTMDB,
	clampMediaWorkLimit,
	dedupeMediaWorks,
	dedupePersonMediaReferences,
	sortMediaWorksByDateThenTitle,
	toMediaReferences
} from './services/entitiesMediaWorkService';
import {
	resolveExistingMediaReferences,
	syncManagedMovieLinks,
	syncManagedTVLinks,
	toDesiredMovieLinks,
	toDesiredTVLinks,
	upsertCompanyRecord,
	upsertPersonRecord
} from './services/entitiesSyncService';
import {
	fetchCompanyFromTMDB,
	fetchCompanyMediaWorksFromTMDB,
	fetchPersonFromTMDB
} from './services/entitiesTMDBService';

const COMPANY_GRAPH_MAX_DISCOVER_PAGES = 8;
const PERSON_LINK_SOURCE = 'tmdb' as const;
const COMPANY_LINK_SOURCE = 'tmdb' as const;
const ENTITY_PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENTITY_PAGE_REFRESH_LOCK_MS = 90_000;
const ENTITY_PAGE_REFRESH_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const ENTITY_PAGE_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ENTITY_PAGE_CACHE_PRUNE_BATCH_SIZE = 200;

const mediaFilterValidator = v.union(v.literal('all'), v.literal('movie'), v.literal('tv'));
const personRoleFilterValidator = v.union(
	v.literal('all'),
	v.literal('actor'),
	v.literal('director'),
	v.literal('creator'),
	v.literal('writer'),
	v.literal('producer')
);
const mediaReferenceValidator = v.object({
	mediaType: v.union(v.literal('movie'), v.literal('tv')),
	tmdbId: v.number(),
	billingOrder: v.number()
});
const mediaWorkValidator = v.object({
	mediaType: v.union(v.literal('movie'), v.literal('tv')),
	tmdbId: v.number(),
	title: v.string(),
	posterPath: v.union(v.string(), v.null()),
	releaseDate: v.union(v.string(), v.null()),
	role: v.union(v.string(), v.null()),
	billingOrder: v.union(v.number(), v.null())
});
const personSummaryValidator = v.object({
	tmdbId: v.number(),
	name: v.string(),
	profilePath: v.union(v.string(), v.null()),
	bio: v.union(v.string(), v.null()),
	movieCreditCount: v.number(),
	tvCreditCount: v.number(),
	roles: v.array(v.string())
});
const companySummaryValidator = v.object({
	tmdbId: v.number(),
	name: v.string(),
	logoPath: v.union(v.string(), v.null()),
	bio: v.union(v.string(), v.null()),
	movieCount: v.number(),
	tvCount: v.number(),
	roles: v.array(v.string())
});

type MediaFilter = 'all' | 'movie' | 'tv';
type PersonRoleFilter = 'all' | 'actor' | 'director' | 'creator' | 'writer' | 'producer';

function selectLatestByFetchedAt<T extends { fetchedAt: number; _creationTime: number }>(
	rows: T[]
): T | null {
	if (rows.length === 0) return null;
	let latest = rows[0]!;
	for (const row of rows) {
		if (
			row.fetchedAt > latest.fetchedAt ||
			(row.fetchedAt === latest.fetchedAt && row._creationTime > latest._creationTime)
		) {
			latest = row;
		}
	}
	return latest;
}

function filterWorksByMediaType(works: MediaWork[], mediaFilter: MediaFilter): MediaWork[] {
	if (mediaFilter === 'all') return works;
	return works.filter((work) => work.mediaType === mediaFilter);
}

function filterPersonWorksByRole(works: MediaWork[], roleFilter: PersonRoleFilter): MediaWork[] {
	if (roleFilter === 'all') return works;
	return works.filter((work) => work.role === roleFilter);
}

async function annotateAndFilterMediaWorks(
	ctx: ActionCtx,
	params: {
		userId: string | null;
		works: MediaWork[];
		mediaFilter: MediaFilter;
		inLibraryOnly: boolean;
		unwatchedOnly: boolean;
		queryContext: MediaQueryContext;
	}
): Promise<AnnotatedMediaWork[]> {
	const works = filterWorksByMediaType(params.works, params.mediaFilter);
	if (works.length === 0) return [];
	const references = toMediaReferences(works);
	const libraryStates = (await ctx.runQuery(internal.entities.resolveMediaLibraryState, {
		userId: params.userId,
		...params.queryContext,
		works: references
	})) as MediaLibraryState[];
	const annotated = annotateMediaWorksWithLibraryState(works, libraryStates);
	return applyMediaWorkFilters(annotated, {
		mediaFilter: 'all',
		inLibraryOnly: params.inLibraryOnly,
		unwatchedOnly: params.unwatchedOnly
	});
}

export const resolveMediaLibraryState = internalQuery({
	args: {
		userId: v.union(v.string(), v.null()),
		personTmdbId: v.optional(v.number()),
		companyTmdbId: v.optional(v.number()),
		works: v.array(mediaReferenceValidator)
	},
	handler: async (ctx, args): Promise<MediaLibraryState[]> => {
		const dedupedReferences = dedupePersonMediaReferences(args.works as PersonMediaReference[]);
		if (dedupedReferences.length === 0) return [];
		const states: MediaLibraryState[] = [];
		const userId = args.userId;
		const personTmdbId = args.personTmdbId ?? null;
		const companyTmdbId = args.companyTmdbId ?? null;

		const linkedMovieIdByTmdbId = new Map<number, Id<'movies'>>();
		const linkedTVIdByTmdbId = new Map<number, Id<'tvShows'>>();
		const movieTmdbIdsToCheck = new Set<number>();
		const tvTmdbIdsToCheck = new Set<number>();

		for (const reference of dedupedReferences) {
			if (reference.mediaType === 'movie') {
				movieTmdbIdsToCheck.add(reference.tmdbId);
			} else {
				tvTmdbIdsToCheck.add(reference.tmdbId);
			}
		}

		if (personTmdbId !== null) {
			if (movieTmdbIdsToCheck.size > 0) {
				const movieCredits = await ctx.db
					.query('movieCredits')
					.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', personTmdbId))
					.collect();
				for (const credit of movieCredits) {
					if (credit.source !== PERSON_LINK_SOURCE) continue;
					const mediaTmdbId =
						typeof credit.mediaTmdbId === 'number'
							? credit.mediaTmdbId
							: (await ctx.db.get(credit.movieId))?.tmdbId;
					if (typeof mediaTmdbId !== 'number') continue;
					if (!movieTmdbIdsToCheck.has(mediaTmdbId)) continue;
					linkedMovieIdByTmdbId.set(mediaTmdbId, credit.movieId);
				}
			}

			if (tvTmdbIdsToCheck.size > 0) {
				const tvCredits = await ctx.db
					.query('tvCredits')
					.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', personTmdbId))
					.collect();
				for (const credit of tvCredits) {
					if (credit.source !== PERSON_LINK_SOURCE) continue;
					const mediaTmdbId =
						typeof credit.mediaTmdbId === 'number'
							? credit.mediaTmdbId
							: (await ctx.db.get(credit.tvShowId))?.tmdbId;
					if (typeof mediaTmdbId !== 'number') continue;
					if (!tvTmdbIdsToCheck.has(mediaTmdbId)) continue;
					linkedTVIdByTmdbId.set(mediaTmdbId, credit.tvShowId);
				}
			}
		} else if (companyTmdbId !== null) {
			if (movieTmdbIdsToCheck.size > 0) {
				const movieCompanyLinks = await ctx.db
					.query('movieCompanies')
					.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', companyTmdbId))
					.collect();
				for (const link of movieCompanyLinks) {
					if (link.source !== COMPANY_LINK_SOURCE) continue;
					const mediaTmdbId =
						typeof link.mediaTmdbId === 'number'
							? link.mediaTmdbId
							: (await ctx.db.get(link.movieId))?.tmdbId;
					if (typeof mediaTmdbId !== 'number') continue;
					if (!movieTmdbIdsToCheck.has(mediaTmdbId)) continue;
					linkedMovieIdByTmdbId.set(mediaTmdbId, link.movieId);
				}
			}

			if (tvTmdbIdsToCheck.size > 0) {
				const tvCompanyLinks = await ctx.db
					.query('tvCompanies')
					.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', companyTmdbId))
					.collect();
				for (const link of tvCompanyLinks) {
					if (link.source !== COMPANY_LINK_SOURCE) continue;
					const mediaTmdbId =
						typeof link.mediaTmdbId === 'number'
							? link.mediaTmdbId
							: (await ctx.db.get(link.tvShowId))?.tmdbId;
					if (typeof mediaTmdbId !== 'number') continue;
					if (!tvTmdbIdsToCheck.has(mediaTmdbId)) continue;
					linkedTVIdByTmdbId.set(mediaTmdbId, link.tvShowId);
				}
			}
		} else {
			// Fallback path when link context is not available.
			const [movies, tvShows] = await Promise.all([
				Promise.all(
					Array.from(movieTmdbIdsToCheck).map(async (movieTmdbId) => ({
						movieTmdbId,
						movie: await ctx.db
							.query('movies')
							.withIndex('by_tmdbId', (q) => q.eq('tmdbId', movieTmdbId))
							.unique()
					}))
				),
				Promise.all(
					Array.from(tvTmdbIdsToCheck).map(async (tvTmdbId) => ({
						tvTmdbId,
						tvShow: await ctx.db
							.query('tvShows')
							.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tvTmdbId))
							.unique()
					}))
				)
			]);
			for (const { movieTmdbId, movie } of movies) {
				if (!movie) continue;
				linkedMovieIdByTmdbId.set(movieTmdbId, movie._id);
			}
			for (const { tvTmdbId, tvShow } of tvShows) {
				if (!tvShow) continue;
				linkedTVIdByTmdbId.set(tvTmdbId, tvShow._id);
			}
		}

		const watchedMovies = new Set<number>();
		const watchedTV = new Set<number>();
		if (userId) {
			const movieTmdbById = new Map<Id<'movies'>, number>();
			const tvTmdbById = new Map<Id<'tvShows'>, number>();
			for (const [tmdbId, movieId] of linkedMovieIdByTmdbId.entries()) {
				movieTmdbById.set(movieId, tmdbId);
			}
			for (const [tmdbId, tvShowId] of linkedTVIdByTmdbId.entries()) {
				tvTmdbById.set(tvShowId, tmdbId);
			}

			const linkedMovieIds = [...movieTmdbById.keys()];
			const linkedTVIds = [...tvTmdbById.keys()];
			const TARGETED_REVIEW_LOOKUP_THRESHOLD = 200;
			const useTargetedLookups =
				linkedMovieIds.length + linkedTVIds.length <= TARGETED_REVIEW_LOOKUP_THRESHOLD;

			if (useTargetedLookups) {
				const [movieChecks, tvChecks] = await Promise.all([
					Promise.all(
						linkedMovieIds.map((movieId) =>
							ctx.db
								.query('movieReviews')
								.withIndex('by_userId_movieId', (q) =>
									q.eq('userId', userId).eq('movieId', movieId)
								)
								.unique()
						)
					),
					Promise.all(
						linkedTVIds.map((tvShowId) =>
							ctx.db
								.query('tvReviews')
								.withIndex('by_userId_tvShowId', (q) =>
									q.eq('userId', userId).eq('tvShowId', tvShowId)
								)
								.unique()
						)
					)
				]);
				for (let i = 0; i < linkedMovieIds.length; i += 1) {
					const review = movieChecks[i];
					if (!review?.watched) continue;
					const tmdbId = movieTmdbById.get(linkedMovieIds[i]!);
					if (typeof tmdbId === 'number') watchedMovies.add(tmdbId);
				}
				for (let i = 0; i < linkedTVIds.length; i += 1) {
					const review = tvChecks[i];
					if (!review?.watched) continue;
					const tmdbId = tvTmdbById.get(linkedTVIds[i]!);
					if (typeof tmdbId === 'number') watchedTV.add(tmdbId);
				}
			} else {
				const [movieReviews, tvReviews] = await Promise.all([
					ctx.db
						.query('movieReviews')
						.withIndex('by_userId', (q) => q.eq('userId', userId))
						.collect(),
					ctx.db
						.query('tvReviews')
						.withIndex('by_userId', (q) => q.eq('userId', userId))
						.collect()
				]);

				for (const review of movieReviews) {
					if (!review.watched) continue;
					const tmdbId = movieTmdbById.get(review.movieId);
					if (typeof tmdbId === 'number') watchedMovies.add(tmdbId);
				}
				for (const review of tvReviews) {
					if (!review.watched) continue;
					const tmdbId = tvTmdbById.get(review.tvShowId);
					if (typeof tmdbId === 'number') watchedTV.add(tmdbId);
				}
			}
		}

		for (const reference of dedupedReferences) {
			if (reference.mediaType === 'movie') {
				const inLibrary = linkedMovieIdByTmdbId.has(reference.tmdbId);
				states.push({
					mediaType: 'movie',
					tmdbId: reference.tmdbId,
					inLibrary,
					watched: inLibrary ? watchedMovies.has(reference.tmdbId) : false
				});
				continue;
			}

			const inLibrary = linkedTVIdByTmdbId.has(reference.tmdbId);
			states.push({
				mediaType: 'tv',
				tmdbId: reference.tmdbId,
				inLibrary,
				watched: inLibrary ? watchedTV.has(reference.tmdbId) : false
			});
		}

		return states;
	}
});

export const syncPersonFromTMDB = internalMutation({
	args: {
		tmdbPersonId: v.number(),
		name: v.string(),
		profilePath: v.union(v.string(), v.null()),
		references: v.array(mediaReferenceValidator)
	},
	handler: async (ctx, args) => {
		const dedupedReferences = dedupePersonMediaReferences(
			args.references as PersonMediaReference[]
		);
		const personId = await upsertPersonRecord(ctx, {
			tmdbId: args.tmdbPersonId,
			name: args.name,
			profilePath: args.profilePath
		});
		const resolvedReferences = await resolveExistingMediaReferences(ctx, dedupedReferences);
		const desiredMovieCredits = toDesiredMovieLinks(resolvedReferences.movies);
		const desiredTVCredits = toDesiredTVLinks(resolvedReferences.tvShows);

		const existingMovieCredits = await ctx.db
			.query('movieCredits')
			.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', args.tmdbPersonId))
			.collect();
		const existingTVCredits = await ctx.db
			.query('tvCredits')
			.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', args.tmdbPersonId))
			.collect();

		await syncManagedMovieLinks({
			ctx,
			existingRows: existingMovieCredits,
			desiredRows: desiredMovieCredits,
			isManagedRow: (row) => row.source === PERSON_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('movieCredits', {
					movieId: row.movieId,
					personId,
					personTmdbId: args.tmdbPersonId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: PERSON_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.personId !== personId ? { personId } : {}),
				...(existing.personTmdbId !== args.tmdbPersonId ? { personTmdbId: args.tmdbPersonId } : {})
			})
		});

		await syncManagedTVLinks({
			ctx,
			existingRows: existingTVCredits,
			desiredRows: desiredTVCredits,
			isManagedRow: (row) => row.source === PERSON_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('tvCredits', {
					tvShowId: row.tvShowId,
					personId,
					personTmdbId: args.tmdbPersonId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: PERSON_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.personId !== personId ? { personId } : {}),
				...(existing.personTmdbId !== args.tmdbPersonId ? { personTmdbId: args.tmdbPersonId } : {})
			})
		});
	}
});

export const syncCompanyFromTMDB = internalMutation({
	args: {
		tmdbCompanyId: v.number(),
		name: v.string(),
		logoPath: v.union(v.string(), v.null()),
		references: v.array(mediaReferenceValidator)
	},
	handler: async (ctx, args) => {
		const dedupedReferences = dedupePersonMediaReferences(
			args.references as PersonMediaReference[]
		);
		const companyId = await upsertCompanyRecord(ctx, {
			tmdbId: args.tmdbCompanyId,
			name: args.name,
			logoPath: args.logoPath
		});
		const resolvedReferences = await resolveExistingMediaReferences(ctx, dedupedReferences);
		const desiredMovieLinks = toDesiredMovieLinks(resolvedReferences.movies);
		const desiredTVLinks = toDesiredTVLinks(resolvedReferences.tvShows);

		const existingMovieLinks = await ctx.db
			.query('movieCompanies')
			.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', args.tmdbCompanyId))
			.collect();
		const existingTVLinks = await ctx.db
			.query('tvCompanies')
			.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', args.tmdbCompanyId))
			.collect();

		await syncManagedMovieLinks({
			ctx,
			existingRows: existingMovieLinks,
			desiredRows: desiredMovieLinks,
			isManagedRow: (row) => row.source === COMPANY_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('movieCompanies', {
					movieId: row.movieId,
					companyId,
					companyTmdbId: args.tmdbCompanyId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: COMPANY_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.companyId !== companyId ? { companyId } : {}),
				...(existing.companyTmdbId !== args.tmdbCompanyId
					? { companyTmdbId: args.tmdbCompanyId }
					: {})
			})
		});

		await syncManagedTVLinks({
			ctx,
			existingRows: existingTVLinks,
			desiredRows: desiredTVLinks,
			isManagedRow: (row) => row.source === COMPANY_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('tvCompanies', {
					tvShowId: row.tvShowId,
					companyId,
					companyTmdbId: args.tmdbCompanyId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: COMPANY_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.companyId !== companyId ? { companyId } : {}),
				...(existing.companyTmdbId !== args.tmdbCompanyId
					? { companyTmdbId: args.tmdbCompanyId }
					: {})
			})
		});
	}
});

export const tryAcquirePersonPageRefresh = internalMutation({
	args: {
		tmdbPersonId: v.number(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const latest = await ctx.db
			.query('personPageCache')
			.withIndex('by_tmdbPersonId_fetchedAt', (q) => q.eq('tmdbPersonId', args.tmdbPersonId))
			.order('desc')
			.first();
		if (!latest) {
			return { acquired: true, cached: null };
		}
		if (latest.nextRefreshAt > args.now) {
			return { acquired: false, cached: latest };
		}
		if ((latest.refreshingUntil ?? 0) > args.now) {
			return { acquired: false, cached: latest };
		}
		await ctx.db.patch(latest._id, {
			refreshingUntil: args.now + ENTITY_PAGE_REFRESH_LOCK_MS
		});
		return { acquired: true, cached: latest };
	}
});

export const deferPersonPageRefresh = internalMutation({
	args: {
		tmdbPersonId: v.number(),
		until: v.number()
	},
	handler: async (ctx, args) => {
		const latest = await ctx.db
			.query('personPageCache')
			.withIndex('by_tmdbPersonId_fetchedAt', (q) => q.eq('tmdbPersonId', args.tmdbPersonId))
			.order('desc')
			.first();
		if (!latest) return;
		await ctx.db.patch(latest._id, {
			refreshingUntil: args.until
		});
	}
});

export const storePersonPageCache = internalMutation({
	args: {
		tmdbPersonId: v.number(),
		summary: personSummaryValidator,
		works: v.array(mediaWorkValidator),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('personPageCache')
			.withIndex('by_tmdbPersonId', (q) => q.eq('tmdbPersonId', args.tmdbPersonId))
			.collect();
		const latest = selectLatestByFetchedAt(rows);
		const nextRefreshAt = args.fetchedAt + ENTITY_PAGE_CACHE_TTL_MS;

		if (latest) {
			await ctx.db.patch(latest._id, {
				summary: args.summary,
				works: args.works,
				fetchedAt: args.fetchedAt,
				nextRefreshAt,
				refreshingUntil: 0
			});
		} else {
			await ctx.db.insert('personPageCache', {
				tmdbPersonId: args.tmdbPersonId,
				summary: args.summary,
				works: args.works,
				fetchedAt: args.fetchedAt,
				nextRefreshAt,
				refreshingUntil: 0
			});
		}

		for (const row of rows) {
			if (!latest || row._id !== latest._id) {
				await ctx.db.delete(row._id);
			}
		}
	}
});

export const tryAcquireCompanyPageRefresh = internalMutation({
	args: {
		tmdbCompanyId: v.number(),
		now: v.number()
	},
	handler: async (ctx, args) => {
		const latest = await ctx.db
			.query('companyPageCache')
			.withIndex('by_tmdbCompanyId_fetchedAt', (q) => q.eq('tmdbCompanyId', args.tmdbCompanyId))
			.order('desc')
			.first();
		if (!latest) {
			return { acquired: true, cached: null };
		}
		if (latest.nextRefreshAt > args.now) {
			return { acquired: false, cached: latest };
		}
		if ((latest.refreshingUntil ?? 0) > args.now) {
			return { acquired: false, cached: latest };
		}
		await ctx.db.patch(latest._id, {
			refreshingUntil: args.now + ENTITY_PAGE_REFRESH_LOCK_MS
		});
		return { acquired: true, cached: latest };
	}
});

export const deferCompanyPageRefresh = internalMutation({
	args: {
		tmdbCompanyId: v.number(),
		until: v.number()
	},
	handler: async (ctx, args) => {
		const latest = await ctx.db
			.query('companyPageCache')
			.withIndex('by_tmdbCompanyId_fetchedAt', (q) => q.eq('tmdbCompanyId', args.tmdbCompanyId))
			.order('desc')
			.first();
		if (!latest) return;
		await ctx.db.patch(latest._id, {
			refreshingUntil: args.until
		});
	}
});

export const storeCompanyPageCache = internalMutation({
	args: {
		tmdbCompanyId: v.number(),
		summary: companySummaryValidator,
		works: v.array(mediaWorkValidator),
		fetchedAt: v.number()
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query('companyPageCache')
			.withIndex('by_tmdbCompanyId', (q) => q.eq('tmdbCompanyId', args.tmdbCompanyId))
			.collect();
		const latest = selectLatestByFetchedAt(rows);
		const nextRefreshAt = args.fetchedAt + ENTITY_PAGE_CACHE_TTL_MS;

		if (latest) {
			await ctx.db.patch(latest._id, {
				summary: args.summary,
				works: args.works,
				fetchedAt: args.fetchedAt,
				nextRefreshAt,
				refreshingUntil: 0
			});
		} else {
			await ctx.db.insert('companyPageCache', {
				tmdbCompanyId: args.tmdbCompanyId,
				summary: args.summary,
				works: args.works,
				fetchedAt: args.fetchedAt,
				nextRefreshAt,
				refreshingUntil: 0
			});
		}

		for (const row of rows) {
			if (!latest || row._id !== latest._id) {
				await ctx.db.delete(row._id);
			}
		}
	}
});

export const getPersonPageFromTMDB = action({
	args: {
		tmdbPersonId: v.number(),
		mediaFilter: v.optional(mediaFilterValidator),
		role: v.optional(personRoleFilterValidator),
		inLibraryOnly: v.optional(v.boolean()),
		unwatchedOnly: v.optional(v.boolean()),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const mediaFilter = (args.mediaFilter ?? 'all') as MediaFilter;
		const roleFilter = (args.role ?? 'all') as PersonRoleFilter;
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = clampMediaWorkLimit(args.limit);
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;
		const now = Date.now();

		let personTmdbId = args.tmdbPersonId;
		let summary: {
			tmdbId: number;
			name: string;
			profilePath: string | null;
			bio: string | null;
			movieCreditCount: number;
			tvCreditCount: number;
			roles: string[];
		};
		let canonicalWorks: MediaWork[];

		const refresh = await ctx.runMutation(internal.entities.tryAcquirePersonPageRefresh, {
			tmdbPersonId: args.tmdbPersonId,
			now
		});
		const cached = refresh.cached as {
			summary: {
				tmdbId: number;
				name: string;
				profilePath: string | null;
				bio: string | null;
				movieCreditCount: number;
				tvCreditCount: number;
				roles: string[];
			};
			works: MediaWork[];
		} | null;

		if (!refresh.acquired && cached) {
			personTmdbId = cached.summary.tmdbId;
			summary = cached.summary;
			canonicalWorks = cached.works;
		} else {
			try {
				const payload = await fetchPersonFromTMDB(args.tmdbPersonId);
				const personMediaReferences = buildPersonMediaReferences(payload);
				await ctx.runMutation(internal.entities.syncPersonFromTMDB, {
					tmdbPersonId: payload.id,
					name: payload.name,
					profilePath: payload.profile_path,
					references: personMediaReferences
				});

				const summaryData = buildPersonMediaWorksFromTMDB(payload, {
					mediaFilter: 'all',
					roleFilter: 'all'
				});
				personTmdbId = payload.id;
				summary = {
					tmdbId: payload.id,
					name: payload.name,
					profilePath: payload.profile_path,
					bio: payload.biography ?? null,
					movieCreditCount: summaryData.movieCreditCount,
					tvCreditCount: summaryData.tvCreditCount,
					roles: summaryData.roles
				};
				canonicalWorks = summaryData.works;

				await ctx.runMutation(internal.entities.storePersonPageCache, {
					tmdbPersonId: payload.id,
					summary,
					works: canonicalWorks,
					fetchedAt: now
				});
			} catch (error) {
				if (!cached) {
					throw error;
				}
				await ctx.runMutation(internal.entities.deferPersonPageRefresh, {
					tmdbPersonId: args.tmdbPersonId,
					until: now + ENTITY_PAGE_REFRESH_FAILURE_BACKOFF_MS
				});
				personTmdbId = cached.summary.tmdbId;
				summary = cached.summary;
				canonicalWorks = cached.works;
			}
		}

		const roleFilteredWorks = filterPersonWorksByRole(canonicalWorks, roleFilter);

		const filtered = await annotateAndFilterMediaWorks(ctx, {
			userId,
			works: roleFilteredWorks,
			mediaFilter,
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				personTmdbId
			}
		});

		return {
			summary,
			works: filtered.slice(0, safeLimit)
		};
	}
});

export const getCompanyPageFromTMDB = action({
	args: {
		tmdbCompanyId: v.number(),
		mediaFilter: v.optional(mediaFilterValidator),
		inLibraryOnly: v.optional(v.boolean()),
		unwatchedOnly: v.optional(v.boolean()),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const mediaFilter = (args.mediaFilter ?? 'all') as MediaFilter;
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = clampMediaWorkLimit(args.limit);
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;
		const now = Date.now();

		let companyTmdbId = args.tmdbCompanyId;
		let summary: {
			tmdbId: number;
			name: string;
			logoPath: string | null;
			bio: string | null;
			movieCount: number;
			tvCount: number;
			roles: string[];
		};
		let canonicalWorks: MediaWork[];

		const refresh = await ctx.runMutation(internal.entities.tryAcquireCompanyPageRefresh, {
			tmdbCompanyId: args.tmdbCompanyId,
			now
		});
		const cached = refresh.cached as {
			summary: {
				tmdbId: number;
				name: string;
				logoPath: string | null;
				bio: string | null;
				movieCount: number;
				tvCount: number;
				roles: string[];
			};
			works: MediaWork[];
		} | null;

		if (!refresh.acquired && cached) {
			companyTmdbId = cached.summary.tmdbId;
			summary = cached.summary;
			canonicalWorks = cached.works;
		} else {
			try {
				const [payload, movieWorks, tvWorks] = await Promise.all([
					fetchCompanyFromTMDB(args.tmdbCompanyId),
					fetchCompanyMediaWorksFromTMDB(
						args.tmdbCompanyId,
						'movie',
						COMPANY_GRAPH_MAX_DISCOVER_PAGES
					),
					fetchCompanyMediaWorksFromTMDB(args.tmdbCompanyId, 'tv', COMPANY_GRAPH_MAX_DISCOVER_PAGES)
				]);

				const roles = movieWorks.length > 0 || tvWorks.length > 0 ? ['production'] : [];
				const deduped = dedupeMediaWorks([...movieWorks, ...tvWorks]).sort(
					sortMediaWorksByDateThenTitle
				);

				await ctx.runMutation(internal.entities.syncCompanyFromTMDB, {
					tmdbCompanyId: payload.id,
					name: payload.name,
					logoPath: payload.logo_path,
					references: toMediaReferences(deduped)
				});

				companyTmdbId = payload.id;
				summary = {
					tmdbId: payload.id,
					name: payload.name,
					logoPath: payload.logo_path,
					bio: payload.description ?? null,
					movieCount: movieWorks.length,
					tvCount: tvWorks.length,
					roles
				};
				canonicalWorks = deduped;

				await ctx.runMutation(internal.entities.storeCompanyPageCache, {
					tmdbCompanyId: payload.id,
					summary,
					works: canonicalWorks,
					fetchedAt: now
				});
			} catch (error) {
				if (!cached) {
					throw error;
				}
				await ctx.runMutation(internal.entities.deferCompanyPageRefresh, {
					tmdbCompanyId: args.tmdbCompanyId,
					until: now + ENTITY_PAGE_REFRESH_FAILURE_BACKOFF_MS
				});
				companyTmdbId = cached.summary.tmdbId;
				summary = cached.summary;
				canonicalWorks = cached.works;
			}
		}

		const filtered = await annotateAndFilterMediaWorks(ctx, {
			userId,
			works: canonicalWorks,
			mediaFilter,
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				companyTmdbId
			}
		});

		return {
			summary,
			works: filtered.slice(0, safeLimit)
		};
	}
});

export const cleanupEntityPageCache = internalMutation({
	args: {
		now: v.number(),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const safeLimit = Math.max(1, Math.min(args.limit ?? ENTITY_PAGE_CACHE_PRUNE_BATCH_SIZE, 1000));
		const staleBefore = args.now - ENTITY_PAGE_CACHE_RETENTION_MS;

		const [stalePeople, staleCompanies] = await Promise.all([
			ctx.db
				.query('personPageCache')
				.withIndex('by_fetchedAt', (q) => q.lt('fetchedAt', staleBefore))
				.take(safeLimit),
			ctx.db
				.query('companyPageCache')
				.withIndex('by_fetchedAt', (q) => q.lt('fetchedAt', staleBefore))
				.take(safeLimit)
		]);

		for (const row of stalePeople) {
			await ctx.db.delete(row._id);
		}
		for (const row of staleCompanies) {
			await ctx.db.delete(row._id);
		}

		return {
			now: args.now,
			personDeleted: stalePeople.length,
			companyDeleted: staleCompanies.length
		};
	}
});

export const cleanupEntityPageCacheArtifacts = internalAction({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		return await ctx.runMutation(internal.entities.cleanupEntityPageCache, {
			now,
			limit: ENTITY_PAGE_CACHE_PRUNE_BATCH_SIZE
		});
	}
});
