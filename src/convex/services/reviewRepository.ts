import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { ResolvedMedia, ReviewMediaType, ReviewSnapshot } from '../types/reviewTypes';

export async function getUserReviewForMedia(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	resolved: ResolvedMedia
): Promise<ReviewSnapshot | null> {
	if (resolved.mediaType === 'movie') {
		const review = await ctx.db
			.query('movieReviews')
			.withIndex('by_userId_movieId', (q) => q.eq('userId', userId).eq('movieId', resolved.media._id))
			.unique();
		if (!review) return null;
		return {
			liked: review.liked,
			watched: review.watched,
			review: review.review,
			rating: review.rating,
			createdAt: review.createdAt
		};
	}

	const review = await ctx.db
		.query('tvReviews')
		.withIndex('by_userId_tvShowId', (q) => q.eq('userId', userId).eq('tvShowId', resolved.media._id))
		.unique();
	if (!review) return null;
	return {
		liked: review.liked,
		watched: review.watched,
		review: review.review,
		rating: review.rating,
		createdAt: review.createdAt
	};
}

export async function getRatingsForMedia(
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

export async function deleteUserReviewForMedia(
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

type UpsertReviewInput =
	| {
			mediaType: 'movie';
			mediaId: Id<'movies'>;
			userId: string;
			rating: string;
			now: number;
	  }
	| {
			mediaType: 'tv';
			mediaId: Id<'tvShows'>;
			userId: string;
			rating: string;
			now: number;
	  };

export async function upsertUserReview(ctx: MutationCtx, input: UpsertReviewInput): Promise<number> {
	if (input.mediaType === 'movie') {
		const existing = await ctx.db
			.query('movieReviews')
			.withIndex('by_userId_movieId', (q) =>
				q.eq('userId', input.userId).eq('movieId', input.mediaId)
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				rating: input.rating,
				updatedAt: input.now
			});
			return existing.createdAt;
		}

		await ctx.db.insert('movieReviews', {
			userId: input.userId,
			movieId: input.mediaId,
			rating: input.rating,
			liked: false,
			watched: true,
			review: null,
			mediaType: 'movie',
			createdAt: input.now,
			updatedAt: input.now
		});
		return input.now;
	}

	const existing = await ctx.db
		.query('tvReviews')
		.withIndex('by_userId_tvShowId', (q) =>
			q.eq('userId', input.userId).eq('tvShowId', input.mediaId)
		)
		.unique();

	if (existing) {
		await ctx.db.patch(existing._id, {
			rating: input.rating,
			updatedAt: input.now
		});
		return existing.createdAt;
	}

	await ctx.db.insert('tvReviews', {
		userId: input.userId,
		tvShowId: input.mediaId,
		rating: input.rating,
		liked: false,
		watched: true,
		review: null,
		mediaType: 'tv',
		createdAt: input.now,
		updatedAt: input.now
	});
	return input.now;
}

export async function getUserMovieReviews(ctx: QueryCtx, userId: string) {
	return await ctx.db
		.query('movieReviews')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.collect();
}

export async function getUserTVReviews(ctx: QueryCtx, userId: string) {
	return await ctx.db
		.query('tvReviews')
		.withIndex('by_userId', (q) => q.eq('userId', userId))
		.collect();
}

export type ReviewListItem = {
	tmdbId?: number;
	traktId?: number;
	imdbId?: string;
	mediaType: ReviewMediaType;
	title: string;
	posterPath: string | null;
	releaseDate: string | null;
	rating: string;
	createdAt: number;
};

export function buildReviewListItem(args: {
	mediaType: ReviewMediaType;
	media: {
		tmdbId?: number;
		traktId?: number;
		imdbId?: string;
		title?: string;
		posterPath?: string | null;
		releaseDate?: string | null;
	} | null;
	rating: string;
	createdAt: number;
	titleFallback: string;
	posterPathFallback: string | null;
}): ReviewListItem {
	return {
		tmdbId: args.media?.tmdbId,
		traktId: args.media?.traktId,
		imdbId: args.media?.imdbId,
		mediaType: args.mediaType,
		title: args.media?.title ?? args.titleFallback,
		posterPath: args.media?.posterPath ?? args.posterPathFallback,
		releaseDate: args.media?.releaseDate ?? null,
		rating: args.rating,
		createdAt: args.createdAt
	};
}
