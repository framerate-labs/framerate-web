import type { MutationCtx, QueryCtx } from './_generated/server';
import type { ReviewMediaType } from './types/reviewTypes';
import type { MediaSource } from './utils/mediaLookup';

import { v } from 'convex/values';

import { mutation, query } from './_generated/server';
import {
	buildReviewListItem,
	deleteUserReviewForMedia,
	getRatingsForMedia,
	getUserMovieReviews,
	getUserReviewForMedia,
	getUserTVReviews,
	upsertUserReview
} from './services/reviewRepository';
import {
	ensureMediaRecord,
	resolveMedia,
	scheduleDetailHydrationForTMDB
} from './services/reviewService';
import { getFinalMovie, getFinalTV } from './utils/mediaLookup';
import {
	computeAverageRating,
	computeRatingDistribution,
	emptyRatingDistribution
} from './utils/reviewStats';
import { validateRating } from './utils/validateRating';

const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));

type MediaLookupArgs = {
	mediaType: ReviewMediaType;
	source: MediaSource;
	externalId: number | string;
};

async function requireIdentity(ctx: QueryCtx | MutationCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Unauthorized: Please login or signup to continue');
	}
	return identity;
}

async function resolveMediaFromArgs(ctx: QueryCtx | MutationCtx, args: MediaLookupArgs) {
	return resolveMedia(ctx, args.mediaType, args.source, args.externalId);
}

async function resolveRatingsFromArgs(ctx: QueryCtx, args: MediaLookupArgs) {
	const resolved = await resolveMediaFromArgs(ctx, args);
	if (!resolved) return null;
	const ratings = await getRatingsForMedia(ctx, resolved);
	return { resolved, ratings };
}

/**
 * Query: Get user's review for a specific media item.
 */
export const get = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const resolved = await resolveMediaFromArgs(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId
		});
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
 */
export const getAll = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		const [movieReviews, tvReviews] = await Promise.all([
			getUserMovieReviews(ctx, identity.subject),
			getUserTVReviews(ctx, identity.subject)
		]);

		const movieDataPromise = Promise.all(
			movieReviews.map(async (review) => {
				const movieBase = await ctx.db.get(review.movieId);
				const movie = movieBase ? await getFinalMovie(ctx, movieBase) : null;
				return {
					...buildReviewListItem({
						mediaType: 'movie',
						media: movie,
						rating: review.rating,
						createdAt: review.createdAt,
						titleFallback: 'Unknown Movie',
						posterPathFallback: null
					}),
					isAnime: movie?.isAnime ?? false
				};
			})
		);

		const tvDataPromise = Promise.all(
			tvReviews.map(async (review) => {
				const tvShowBase = await ctx.db.get(review.tvShowId);
				const tvShow = tvShowBase ? await getFinalTV(ctx, tvShowBase) : null;
				return {
					...buildReviewListItem({
						mediaType: 'tv',
						media: tvShow,
						rating: review.rating,
						createdAt: review.createdAt,
						titleFallback: 'Unknown Show',
						posterPathFallback: null
					}),
					isAnime: tvShow?.isAnime ?? false
				};
			})
		);
		const [movieData, tvData] = await Promise.all([movieDataPromise, tvDataPromise]);

		return [...movieData, ...tvData].sort((a, b) => b.createdAt - a.createdAt);
	}
});

/**
 * Query: Get average rating and review count for a media item.
 */
export const getAverage = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const ratingsData = await resolveRatingsFromArgs(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId
		});
		if (!ratingsData) {
			return { avgRating: null, reviewCount: 0 };
		}

		const avgRating = computeAverageRating(ratingsData.ratings);
		if (avgRating === null) {
			return { avgRating: null, reviewCount: 0 };
		}

		return {
			avgRating,
			reviewCount: ratingsData.ratings.length
		};
	}
});

/**
 * Query: Get rating distribution for a media item.
 */
export const getDistribution = query({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const ratingsData = await resolveRatingsFromArgs(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId
		});
		if (!ratingsData) return emptyRatingDistribution();

		return computeRatingDistribution(ratingsData.ratings);
	}
});

/**
 * Mutation: Add or update a review (upsert).
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
		const identity = await requireIdentity(ctx);

		const ratingTrimmed = args.rating.trim();
		const error = validateRating(ratingTrimmed);
		if (error) {
			throw new Error(error);
		}

		const now = Date.now();
		const ensured = await ensureMediaRecord(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId,
			title: args.title,
			posterPath: args.posterPath,
			now
		});

		if (ensured.mediaType === 'movie') {
			const createdAt = await upsertUserReview(ctx, {
				mediaType: 'movie',
				mediaId: ensured.mediaId,
				userId: identity.subject,
				rating: ratingTrimmed,
				now
			});
			if (ensured.shouldHydrateDetails) {
				await scheduleDetailHydrationForTMDB(ctx, 'movie', args.source, args.externalId);
			}
			const finalMovieBase = await ctx.db.get(ensured.mediaId);
			const finalMovie = finalMovieBase ? await getFinalMovie(ctx, finalMovieBase) : null;
			return {
				tmdbId: finalMovie?.tmdbId,
				traktId: finalMovie?.traktId,
				imdbId: finalMovie?.imdbId,
				mediaType: 'movie' as const,
				title: finalMovie?.title ?? args.title,
				posterPath: finalMovie?.posterPath ?? args.posterPath,
				rating: ratingTrimmed,
				createdAt
			};
		}

		const createdAt = await upsertUserReview(ctx, {
			mediaType: 'tv',
			mediaId: ensured.mediaId,
			userId: identity.subject,
			rating: ratingTrimmed,
			now
		});
		if (ensured.shouldHydrateDetails) {
			await scheduleDetailHydrationForTMDB(ctx, 'tv', args.source, args.externalId);
		}
		const finalTvShowBase = await ctx.db.get(ensured.mediaId);
		const finalTvShow = finalTvShowBase ? await getFinalTV(ctx, finalTvShowBase) : null;
		return {
			tmdbId: finalTvShow?.tmdbId,
			traktId: finalTvShow?.traktId,
			imdbId: finalTvShow?.imdbId,
			mediaType: 'tv' as const,
			title: finalTvShow?.title ?? args.title,
			posterPath: finalTvShow?.posterPath ?? args.posterPath,
			rating: ratingTrimmed,
			createdAt
		};
	}
});

/**
 * Mutation: Delete a review.
 */
export const deleteReview = mutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const resolved = await resolveMediaFromArgs(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId
		});
		if (!resolved) return false;

		return deleteUserReviewForMedia(ctx, identity.subject, resolved);
	}
});
