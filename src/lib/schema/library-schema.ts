import { z } from 'zod/v4';

export const librarySearchSchema = z.object({
	filter: z.enum(['film', 'series']).optional()
});
