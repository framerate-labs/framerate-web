/**
 * Validates that a rating string is a valid number between 1-10 in 0.5 increments.
 *
 * @param raw - The rating string to validate
 * @returns Error message string if invalid, null if valid
 */
export function validateRating(raw: string): string | null {
	const val = Number(raw.trim());
	if (isNaN(val)) return 'Rating must be a valid number';

	// Accept 1.0 through 10.0 inclusive
	if (val < 1 || val > 10) return 'Rating must be between 1 and 10';

	// Enforce 0.5 increments: 1.0, 1.5, 2.0, ... 10.0
	const roundedToHalf = Math.round(val * 2) / 2;
	if (Math.abs(val - roundedToHalf) > 1e-9) return 'Rating must be in 0.5 increments';

	return null;
}
