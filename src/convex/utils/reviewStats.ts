const MIN_RATING = 1;
const MAX_RATING = 10;
const BUCKET_SIZE = 0.5;

export const RATING_BUCKET_COUNT = Math.round((MAX_RATING - MIN_RATING) / BUCKET_SIZE) + 1;

export type RatingDistribution = {
	counts: number[];
	totalCount: number;
};

export function emptyRatingDistribution(): RatingDistribution {
	return {
		counts: Array(RATING_BUCKET_COUNT).fill(0),
		totalCount: 0
	};
}

function bucketize(rating: string): number | null {
	const value = Number(rating);
	if (Number.isNaN(value)) return null;
	const clamped = Math.min(MAX_RATING, Math.max(MIN_RATING, value));
	const steps = Math.round((clamped - MIN_RATING) / BUCKET_SIZE);
	return Math.min(RATING_BUCKET_COUNT - 1, Math.max(0, steps));
}

export function computeAverageRating(reviews: Array<{ rating: string }>): number | null {
	if (reviews.length === 0) return null;
	const sum = reviews.reduce((acc, review) => acc + Number(review.rating), 0);
	return Number((sum / reviews.length).toFixed(1));
}

export function computeRatingDistribution(reviews: Array<{ rating: string }>): RatingDistribution {
	if (reviews.length === 0) return emptyRatingDistribution();

	const counts = Array(RATING_BUCKET_COUNT).fill(0);
	for (const review of reviews) {
		const index = bucketize(review.rating);
		if (index === null) continue;
		counts[index] += 1;
	}

	return {
		counts,
		totalCount: reviews.length
	};
}
