import { z } from 'zod/v4';

export const loginSchema = z.object({
	email: z.email({ message: 'Invalid email address' }).trim().toLowerCase(),
	password: z
		.string()
		.trim()
		.min(1, { message: 'Please enter a password' })
		.max(100, { message: 'Password must be 100 characters or less' })
});

export const signupSchema = z.object({
	email: z.email({ message: 'Invalid email address' }).trim().toLowerCase(),
	name: z
		.string()
		.trim()
		.min(1, { message: 'Name must be at least 1 character' })
		.max(50, { message: 'Name must be 50 characters or less' })
		.regex(/^[^+\-*/=^%&<>!@#,$(){}[\]]*$/, {
			message: 'Name cannot contain special characters'
		}),
	username: z
		.string()
		.trim()
		.min(1, { message: 'Username must be at least 1 character' })
		.max(20, { message: 'Username must be 20 characters or less' })
		.regex(/[a-zA-Z]/, {
			message: 'Username must contain at least 1 letter'
		})
		.regex(/^[A-Za-z].*$/, {
			message: 'Username must start with a letter'
		})
		.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
			message:
				'Username must start with a letter or number, and contain only letters, numbers, hyphens, or underscores'
		})
		.refine((s) => !s.includes(' '), 'Spaces are not allowed in usernames'),
	password: z
		.string()
		.trim()
		.min(10, { message: 'Password must be at least 10 characters' })
		.max(40, { message: 'Password must be 40 characters or less' })
		.regex(/[a-zA-Z]/, {
			message: 'Password must contain at least 1 letter'
		})
		.regex(/[0-9]/, { message: 'Password must contain at least 1 number' })
		.refine((s) => !s.includes(' '), 'Spaces are not allowed in passwords')
});

export type LoginSchema = typeof loginSchema;
export type SignupSchema = typeof signupSchema;
