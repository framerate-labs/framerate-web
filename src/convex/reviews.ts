import type { Id } from './_generated/dataModel';
import type { MediaSource } from './utils/mediaLookup';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { ResolvedMedia, ReviewSnapshot } from './types/reviewTypes';

import { v } from 'convex/values';

import { api } from './_generated/api';
import { mutation, query } from './_generated/server';
import { getMovieBySource, getTVShowBySource } from './utils/mediaLookup';
import { validateRating } from './utils/validateRating';

// Argument validators
const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));

function needsDetailHydration(media: {
	detailSchemaVersion?: number | null;
	detailFetchedAt?: number | null;
	creatorCredits?: unknown[] | null;
}): boolean {
	return (
		(media.detailSchemaVersion ?? 0) < 1 ||
		media.detailFetchedAt === null ||
		media.detailFetchedAt === undefined ||
		(media.creatorCredits ?? []).length === 0
	);
}

async function scheduleDetailHydrationForTMDB(
	ctx: {
		scheduler: {
			runAfter: (
				delayMs: number,
				fn: typeof api.details.refreshIfStale,
				args: {
					mediaType: 'movie' | 'tv';
					id: number;
					source: 'tmdb';
					force: boolean;
				}
			) => Promise<unknown>;
		};
	},
	mediaType: 'movie' | 'tv',
	source: MediaSource,
	externalId: number | string
): Promise<void> {
	if (source !== 'tmdb' || typeof externalId !== 'number') return;
	try {
		await ctx.scheduler.runAfter(0, api.details.refreshIfStale, {
			mediaType,
			id: externalId,
			source: 'tmdb',
			force: true
		});
	} catch {
		// Best effort only; review writes should not fail if hydration scheduling fails.
	}
}

function applyExternalSourceId(
	target: { tmdbId?: number; traktId?: number; imdbId?: string },
	source: MediaSource,
	externalId: number | string
): void {
	if (source === 'tmdb') {
		target.tmdbId = externalId as number;
		return;
	}
	if (source === 'trakt') {
		target.traktId = externalId as number;
		return;
	}
	target.imdbId = externalId as string;
}

async function resolveMedia(
	ctx: QueryCtx | MutationCtx,
	mediaType: 'movie' | 'tv',
	source: MediaSource,
	externalId: number | string
): Promise<ResolvedMedia | null> {
	if (mediaType === 'movie') {
		const movie = await getMovieBySource(ctx, source, externalId);
		return movie ? { mediaType: 'movie', media: movie } : null;
	}
	const tvShow = await getTVShowBySource(ctx, source, externalId);
	return tvShow ? { mediaType: 'tv', media: tvShow } : null;
}

async function getUserReviewForMedia(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	resolved: ResolvedMedia
): Promise<ReviewSnapshot | null> {
	if (resolved.mediaType === 'movie') {
		const review = await ctx.db
			.query('movieReviews')
			.withIndex('by_userId_movieId', (q) => q.eq('userId', userId).eq('movieId', resolved.media._id))
			.unique();
		return review
			? {
					liked: review.liked,
					watched: review.watched,
					review: review.review,
					rating: review.rating,
					createdAt: review.createdAt
				}
			: null;
	}

	const review = await ctx.db
		.query('tvReviews')
		.withIndex('by_userId_tvShowId', (q) => q.eq('userId', userId).eq('tvShowId', resolved.media._id))
		.unique();
	return review
		? {
				liked: review.liked,
				watched: review.watched,
				review: review.review,
				rating: review.rating,
				createdAt: review.createdAt
			}
		: null;
}

async function getRatingsForMedia(
	ctx: QueryCtx | MutationCtx,
	resolved: ResolvedMedia
): Promise<Array<{ rating: string }>> {
	if (resolved.mediaType === 'movie') {
		return await ctx.db
			.query('movieReviews')
			.withIndex('by_movieId', (q) => q.eq('movieId', resolved.media._id))
			.collect();
	}
	return await ctx.db
		.query('tvReviews')
		.withIndex('by_tvShowId', (q) => q.eq('tvShowId', resolved.media._id))
		.collect();
}

async function deleteUserReviewForMedia(
	ctx: MutationCtx,
	userId: string,
	resolved: ResolvedMedia
): Promise<boolean> {
	if (resolved.mediaType === 'movie') {
		const review = await ctx.db
			.query('movieReviews')
			.withIndex('by_userId_movieId', (q) => q.eq('userId', userId).eq('movieId', resolved.media._id))
			.unique();
		if (!review) return false;
		await ctx.db.delete(review._id);
		return true;
	}
	const review = await ctx.db
		.query('tvReviews')
		.withIndex('by_userId_tvShowId', (q) => q.eq('userId', userId).eq('tvShowId', resolved.media._id))
		.unique();
	if (!review) return false;
	await ctx.db.delete(review._id);
	return true;
}

function createMovieSeedData(args: {
	source: MediaSource;
	externalId: number | string;
	title: string;
	posterPath: string | null;
	now: number;
}) {
	const movieData: {
		tmdbId?: number;
		traktId?: number;
		imdbId?: string;
		title: string;
		posterPath: string | null;
		backdropPath: null;
		releaseDate: null;
		overview: null;
		status: null;
		runtime: null;
		director: null;
		creatorCredits: [];
		detailSchemaVersion: number;
		detailFetchedAt: null;
		nextRefreshAt: number;
		refreshErrorCount: number;
		lastRefreshErrorAt: null;
	} = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: null,
		releaseDate: null,
		overview: null,
		status: null,
		runtime: null,
		director: null,
		creatorCredits: [],
		detailSchemaVersion: 0,
		detailFetchedAt: null,
		nextRefreshAt: args.now,
		refreshErrorCount: 0,
		lastRefreshErrorAt: null
	};
	applyExternalSourceId(movieData, args.source, args.externalId);
	return movieData;
}

function createTVSeedData(args: {
	source: MediaSource;
	externalId: number | string;
	title: string;
	posterPath: string | null;
	now: number;
}) {
	const tvShowData: {
		tmdbId?: number;
		traktId?: number;
		imdbId?: string;
		title: string;
		posterPath: string | null;
		backdropPath: null;
		releaseDate: null;
		overview: null;
		status: null;
		numberOfSeasons: null;
		lastAirDate: null;
		lastEpisodeToAir: null;
		nextEpisodeToAir: null;
		creator: null;
		creatorCredits: [];
		detailSchemaVersion: number;
		detailFetchedAt: null;
		nextRefreshAt: number;
		refreshErrorCount: number;
		lastRefreshErrorAt: null;
	} = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: null,
		releaseDate: null,
		overview: null,
		status: null,
		numberOfSeasons: null,
		lastAirDate: null,
		lastEpisodeToAir: null,
		nextEpisodeToAir: null,
		creator: null,
		creatorCredits: [],
		detailSchemaVersion: 0,
		detailFetchedAt: null,
		nextRefreshAt: args.now,
		refreshErrorCount: 0,
		lastRefreshErrorAt: null
	};
	applyExternalSourceId(tvShowData, args.source, args.externalId);
	return tvShowData;
}

/**
 * Query: Get user's review for a specific media item.
 *
 * Requires authentication.
 * Returns null if the user hasn't reviewed the item.
 *
 * @param mediaType - "movie" | "tv"
 * @param source - Data source ("tmdb" | "trakt" | "imdb")
 * @param externalId - External ID from the source
 * @returns { liked, watched, review, rating } | null
 */
export const get = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}

		const resolved = await resolveMedia(
			ctx,
			args.mediaType as 'movie' | 'tv',
			args.source as MediaSource,
			args.externalId
		);
		if (!resolved) return null;

		const review = await getUserReviewForMedia(ctx, identity.subject, resolved);
		if (!review) return null;

		return {
			liked: review.liked,
			watched: review.watched,
			review: review.review,
			rating: review.rating
		};
	}
});

/**
 * Query: Get all reviews created by the authenticated user.
 *
 * Returns reviews from both movies and TV shows in a single array.
 * Requires authentication.
 * Returns tmdbId if available (for backwards compatibility), but also includes all source IDs.
 *
 * @returns Array<{ tmdbId?, traktId?, imdbId?, mediaType, title, posterPath, releaseDate, rating, createdAt }>
 */
export const getAll = query({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}

		// Fetch movie reviews
		const movieReviews = await ctx.db
			.query('movieReviews')
			.withIndex('by_userId', (q) => q.eq('userId', identity.subject))
			.collect();

		// Fetch TV reviews
		const tvReviews = await ctx.db
			.query('tvReviews')
			.withIndex('by_userId', (q) => q.eq('userId', identity.subject))
			.collect();

		// Fetch movie metadata using internal IDs
		const movieData = await Promise.all(
			movieReviews.map(async (review) => {
				const movie = await ctx.db.get(review.movieId);

				return {
					tmdbId: movie?.tmdbId,
					traktId: movie?.traktId,
					imdbId: movie?.imdbId,
					mediaType: 'movie' as const,
					title: movie?.title ?? 'Unknown Movie',
					posterPath: movie?.posterPath ?? null,
					releaseDate: movie?.releaseDate ?? null,
					rating: review.rating,
					createdAt: review.createdAt
				};
			})
		);

		// Fetch TV metadata using internal IDs
		const tvData = await Promise.all(
			tvReviews.map(async (review) => {
				const tvShow = await ctx.db.get(review.tvShowId);

				return {
					tmdbId: tvShow?.tmdbId,
					traktId: tvShow?.traktId,
					imdbId: tvShow?.imdbId,
					mediaType: 'tv' as const,
					title: tvShow?.title ?? 'Unknown Show',
					posterPath: tvShow?.posterPath ?? null,
					releaseDate: tvShow?.releaseDate ?? null,
					rating: review.rating,
					createdAt: review.createdAt
				};
			})
		);

		// Combine and sort by createdAt descending (newest first)
		return [...movieData, ...tvData].sort((a, b) => b.createdAt - a.createdAt);
	}
});

/**
 * Query: Get average rating and review count for a media item.
 *
 * Public endpoint - no authentication required.
 * Returns avgRating as null if there are no reviews.
 *
 * @param mediaType - "movie" | "tv"
 * @param source - Data source ("tmdb" | "trakt" | "imdb")
 * @param externalId - External ID from the source
 * @returns { avgRating: number | null, reviewCount: number }
 */
export const getAverage = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const resolved = await resolveMedia(
			ctx,
			args.mediaType as 'movie' | 'tv',
			args.source as MediaSource,
			args.externalId
		);
		if (!resolved) {
			return { avgRating: null, reviewCount: 0 };
		}

		const reviews = await getRatingsForMedia(ctx, resolved);
		if (reviews.length === 0) {
			return { avgRating: null, reviewCount: 0 };
		}

		const sum = reviews.reduce((acc, review) => acc + Number(review.rating), 0);
		const avgRating = sum / reviews.length;

		return {
			avgRating: Number(avgRating.toFixed(1)),
			reviewCount: reviews.length
		};
	}
});

/**
 * Query: Get rating distribution for a media item.
 *
 * Public endpoint - no authentication required.
 * Returns counts for 0.5 rating buckets (1.0 → 10.0).
 *
 * @param mediaType - "movie" | "tv"
 * @param source - Data source ("tmdb" | "trakt" | "imdb")
 * @param externalId - External ID from the source
 * @returns { counts: number[], totalCount: number }
 */
export const getDistribution = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const minRating = 1;
		const maxRating = 10;
		const bucketSize = 0.5;
		const bucketCount = Math.round((maxRating - minRating) / bucketSize) + 1;
		const empty = {
			counts: Array(bucketCount).fill(0),
			totalCount: 0
		};

		const bucketize = (rating: string) => {
			const value = Number(rating);
			if (Number.isNaN(value)) return null;
			const clamped = Math.min(maxRating, Math.max(minRating, value));
			const steps = Math.round((clamped - minRating) / bucketSize);
			return Math.min(bucketCount - 1, Math.max(0, steps));
		};

		const resolved = await resolveMedia(
			ctx,
			args.mediaType as 'movie' | 'tv',
			args.source as MediaSource,
			args.externalId
		);
		if (!resolved) return empty;

		const reviews = await getRatingsForMedia(ctx, resolved);
		if (reviews.length === 0) return empty;

		const counts = Array(bucketCount).fill(0);
		for (const review of reviews) {
			const index = bucketize(review.rating);
			if (index === null) continue;
			counts[index] += 1;
		}

		return { counts, totalCount: reviews.length };
	}
});

/**
 * Mutation: Add or update a review (upsert).
 *
 * Requires authentication.
 * Validates rating format before saving.
 * Ensures media exists in DB before creating review (creates if needed).
 * On conflict (same user + media), updates rating and updatedAt.
 *
 * @param mediaType - "movie" | "tv"
 * @param source - Data source ("tmdb" | "trakt" | "imdb")
 * @param externalId - External ID from the source
 * @param title - Media title (for creating media record if needed)
 * @param posterPath - Poster path (for creating media record if needed)
 * @param rating - String rating (e.g., "7.5")
 * @returns Library row with updated review data (includes all source IDs)
 */
export const add = mutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		rating: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}

		// Validate rating
		const ratingTrimmed = args.rating.trim();
		const error = validateRating(ratingTrimmed);
		if (error) {
			throw new Error(error);
		}

		const now = Date.now();

		if (args.mediaType === 'movie') {
			const movie = await getMovieBySource(ctx, args.source as MediaSource, args.externalId);
			let movieId: Id<'movies'>;
			let shouldHydrateDetails = movie ? needsDetailHydration(movie) : false;
			if (!movie) {
				movieId = await ctx.db.insert(
					'movies',
					createMovieSeedData({
						source: args.source as MediaSource,
						externalId: args.externalId,
						title: args.title,
						posterPath: args.posterPath,
						now
					})
				);
				shouldHydrateDetails = true;
			} else {
				movieId = movie._id;
			}

			const existing = await ctx.db
				.query('movieReviews')
				.withIndex('by_userId_movieId', (q) =>
					q.eq('userId', identity.subject).eq('movieId', movieId)
				)
				.unique();

			let reviewCreatedAt = now;
			if (existing) {
				reviewCreatedAt = existing.createdAt;
				await ctx.db.patch(existing._id, {
					rating: ratingTrimmed,
					updatedAt: now
				});
			} else {
				await ctx.db.insert('movieReviews', {
					userId: identity.subject,
					movieId,
					rating: ratingTrimmed,
					liked: false,
					watched: true,
					review: null,
					mediaType: 'movie',
					createdAt: now,
					updatedAt: now
				});
			}

			if (shouldHydrateDetails) {
				await scheduleDetailHydrationForTMDB(
					ctx,
					'movie',
					args.source as MediaSource,
					args.externalId
				);
			}

			const finalMovie = await ctx.db.get(movieId);
			return {
				tmdbId: finalMovie?.tmdbId,
				traktId: finalMovie?.traktId,
				imdbId: finalMovie?.imdbId,
				mediaType: 'movie' as const,
				title: finalMovie?.title ?? args.title,
				posterPath: finalMovie?.posterPath ?? args.posterPath,
				rating: ratingTrimmed,
				createdAt: reviewCreatedAt
			};
		}

		const tvShow = await getTVShowBySource(ctx, args.source as MediaSource, args.externalId);
		let tvShowId: Id<'tvShows'>;
		let shouldHydrateDetails = tvShow ? needsDetailHydration(tvShow) : false;
			if (!tvShow) {
				tvShowId = await ctx.db.insert(
					'tvShows',
					createTVSeedData({
						source: args.source as MediaSource,
						externalId: args.externalId,
						title: args.title,
						posterPath: args.posterPath,
						now
					})
				);
				shouldHydrateDetails = true;
			} else {
				tvShowId = tvShow._id;
		}

		const existing = await ctx.db
			.query('tvReviews')
			.withIndex('by_userId_tvShowId', (q) =>
				q.eq('userId', identity.subject).eq('tvShowId', tvShowId)
			)
			.unique();

		let reviewCreatedAt = now;
		if (existing) {
			reviewCreatedAt = existing.createdAt;
			await ctx.db.patch(existing._id, {
				rating: ratingTrimmed,
				updatedAt: now
			});
		} else {
			await ctx.db.insert('tvReviews', {
				userId: identity.subject,
				tvShowId,
				rating: ratingTrimmed,
				liked: false,
				watched: true,
				review: null,
				mediaType: 'tv',
				createdAt: now,
				updatedAt: now
			});
		}

		if (shouldHydrateDetails) {
			await scheduleDetailHydrationForTMDB(ctx, 'tv', args.source as MediaSource, args.externalId);
		}

		const finalTvShow = await ctx.db.get(tvShowId);
		return {
			tmdbId: finalTvShow?.tmdbId,
			traktId: finalTvShow?.traktId,
			imdbId: finalTvShow?.imdbId,
			mediaType: 'tv' as const,
			title: finalTvShow?.title ?? args.title,
			posterPath: finalTvShow?.posterPath ?? args.posterPath,
			rating: ratingTrimmed,
			createdAt: reviewCreatedAt
		};
	}
});

/**
 * Mutation: Delete a review.
 *
 * Requires authentication.
 * Returns true if deleted, false if review didn't exist.
 *
 * @param mediaType - "movie" | "tv"
 * @param source - Data source ("tmdb" | "trakt" | "imdb")
 * @param externalId - External ID from the source
 * @returns boolean indicating if deletion occurred
 */
export const deleteReview = mutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new Error('Unauthorized: Please login or signup to continue');
		}

		const resolved = await resolveMedia(
			ctx,
			args.mediaType as 'movie' | 'tv',
			args.source as MediaSource,
			args.externalId
		);
		if (!resolved) return false;

		return await deleteUserReviewForMedia(ctx, identity.subject, resolved);
	}
});
