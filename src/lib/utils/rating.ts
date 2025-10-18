/**
 * Validates a rating string
 * @returns null for success, error message string for failure
 */
export function validateRating(raw: string): string | null {
	const val = Number(raw.trim());

	if (isNaN(val)) return 'Rating must be a valid number';

	if (val < 0.5 || val > 5) return 'Rating must be between 0.5 and 5';

	if (val * 2 !== Math.floor(val * 2)) return 'Rating must be in 0.5 increments';

	return null;
}

/**
 * Maps a rating from a 1–10 (0.5 step) scale
 * to a 0.5–5 (0.5 step) scale.
 *
 * Simple division by 2 with rounding:
 *  1.0 → 0.5
 *  2.0 → 1.0
 *  5.0 → 2.5
 *  8.0 → 4.0
 *  8.5 → 4.5 (rounded from 4.25)
 * 10.0 → 5.0
 */
export function mapRatingToFiveScale(rating: number): number {
	if (rating < 1 || rating > 10) {
		throw new RangeError('Rating must be between 1 and 10');
	}

	// Divide by 2 and round to nearest 0.5
	const scaled = rating / 2;
	return Math.round(scaled * 2) / 2;
}

/**
 * Expands a 0.5–5 (0.5 step) rating to a 1–10 (0.5 step) scale.
 *
 * Simple multiplication by 2:
 * 0.5 → 1.0
 * 1.0 → 2.0
 * 2.5 → 5.0
 * 4.0 → 8.0
 * 5.0 → 10.0
 */
export function mapFiveToTen(rating: number): number {
	if (rating < 0.5 || rating > 5) {
		throw new RangeError('Rating must be between 0.5 and 5');
	}

	// Simply multiply by 2
	return rating * 2;
}
