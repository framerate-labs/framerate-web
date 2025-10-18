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
