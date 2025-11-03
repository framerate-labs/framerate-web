import { z } from 'zod';

export const listSchema = z.object({
	listName: z
		.string()
		.trim()
		.min(1, { message: 'Collection name must be at least 1 character.' })
		.max(100, { message: 'Collection name must be less than 100 characters.' })
});

export const listItemSchema = z.object({
	listId: z.number().int().positive().min(1),
	mediaType: z.enum(['movie', 'tv']),
	mediaId: z.number().int().positive().min(1)
});
