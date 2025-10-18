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
 * Example:
 *  1.0 → 0.5
 *  2.5 → 1.0
 *  5.0 → 2.5
 *  7.5 → 4.0
 * 10.0 → 5.0
 */
export function mapRatingToFiveScale(rating: number): number {
	if (rating < 1 || rating > 10) {
		throw new RangeError('Rating must be between 1 and 10');
	}

	// Linearly map 1–10 → 0.5–5
	const scaled = 0.5 + ((rating - 1) / 9) * 4.5;

	// Round to nearest 0.5
	const rounded = Math.round(scaled * 2) / 2;

	return rounded;
}

/**
 * Expands a 0.5–5 (0.5 step) rating to a 1–10 (0.5 step) scale
 * while preserving proportional meaning.
 */
export function mapFiveToTen(rating: number): number {
	if (rating < 0.5 || rating > 5) {
		throw new RangeError('Rating must be between 0.5 and 5');
	}

	// Linear map: 0.5–5 → 1–10
	const scaled = 1 + ((rating - 0.5) / 4.5) * 9;

	// Optional rounding to nearest 0.5 step
	const rounded = Math.round(scaled * 2) / 2;

	return rounded;
}
