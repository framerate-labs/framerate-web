import { dev } from '$app/environment';

const baseURL = dev ? 'http://localhost:8000' : 'https://api.frame-rate.io';

interface BetterAuthUser {
	id: string;
	email: string;
	name: string;
	username: string;
	emailVerified: boolean;
	image?: string | null;
	createdAt: Date;
	updatedAt: Date;
}

interface BetterAuthSessionResponse {
	user: BetterAuthUser | null;
	session: {
		id: string;
		userId: string;
		expiresAt: Date;
		token: string;
		ipAddress?: string;
		userAgent?: string;
	} | null;
}

/**
 * Server-side session validation using Better Auth's cookie cache.
 * This reads the session token from cookies and validates it against the API.
 */
export async function getServerSession(request: Request): Promise<BetterAuthUser | null> {
	try {
		// Better Auth uses 'framerate.session_token' cookie (cookiePrefix from server config)
		const cookieHeader = request.headers.get('cookie');

		if (!cookieHeader) {
			return null;
		}

		const response = await fetch(`${baseURL}/api/auth/get-session`, {
			headers: {
				cookie: cookieHeader
			}
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as BetterAuthSessionResponse;

		return data.user ?? null;
	} catch (error) {
		console.error('Failed to get server session:', error);
		return null;
	}
}
