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
import { action, internalMutation, internalQuery } from './_generated/server';
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

async function annotateAndFilterMediaWorks(
	ctx: ActionCtx,
	params: {
		userId: string | null;
		works: MediaWork[];
		mediaFilter: 'all' | 'movie' | 'tv';
		inLibraryOnly: boolean;
		unwatchedOnly: boolean;
		queryContext: MediaQueryContext;
	}
): Promise<AnnotatedMediaWork[]> {
	const references = toMediaReferences(params.works);
	const libraryStates = (await ctx.runQuery(internal.entities.resolveMediaLibraryState, {
		userId: params.userId,
		...params.queryContext,
		works: references
	})) as MediaLibraryState[];
	const annotated = annotateMediaWorksWithLibraryState(params.works, libraryStates);
	return applyMediaWorkFilters(annotated, {
		mediaFilter: params.mediaFilter,
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
		} else if (companyTmdbId !== null) {
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
		const mediaFilter = (args.mediaFilter ?? 'all') as 'all' | 'movie' | 'tv';
		const roleFilter = (args.role ?? 'all') as
			| 'all'
			| 'actor'
			| 'director'
			| 'creator'
			| 'writer'
			| 'producer';
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = clampMediaWorkLimit(args.limit);
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;

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
		const worksData = buildPersonMediaWorksFromTMDB(payload, {
			mediaFilter,
			roleFilter
		});

		const filtered = await annotateAndFilterMediaWorks(ctx, {
			userId,
			works: worksData.works,
			mediaFilter: 'all',
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				personTmdbId: payload.id
			}
		});

		return {
			summary: {
				tmdbId: payload.id,
				name: payload.name,
				profilePath: payload.profile_path,
				bio: payload.biography ?? null,
				movieCreditCount: summaryData.movieCreditCount,
				tvCreditCount: summaryData.tvCreditCount,
				roles: summaryData.roles
			},
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
		const mediaFilter = (args.mediaFilter ?? 'all') as 'all' | 'movie' | 'tv';
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = clampMediaWorkLimit(args.limit);
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;

		const [payload, movieWorks, tvWorks] = await Promise.all([
			fetchCompanyFromTMDB(args.tmdbCompanyId),
			fetchCompanyMediaWorksFromTMDB(args.tmdbCompanyId, 'movie', COMPANY_GRAPH_MAX_DISCOVER_PAGES),
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
		const filtered = await annotateAndFilterMediaWorks(ctx, {
			userId,
			works: deduped,
			mediaFilter,
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				companyTmdbId: payload.id
			}
		});

		return {
			summary: {
				tmdbId: payload.id,
				name: payload.name,
				logoPath: payload.logo_path,
				bio: payload.description ?? null,
				movieCount: movieWorks.length,
				tvCount: tvWorks.length,
				roles
			},
			works: filtered.slice(0, safeLimit)
		};
	}
});
