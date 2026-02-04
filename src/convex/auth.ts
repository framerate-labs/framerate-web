/**
 * Authentication and Session Management
 *
 * This module handles secure token refresh with WorkOS.
 * Refresh tokens are stored server-side and never sent to the client after initial login.
 *
 * Flow:
 * 1. Client authenticates with WorkOS, receives access + refresh tokens
 * 2. Client calls `storeSession` to securely store refresh token in Convex
 * 3. When access token expires, client calls `refreshAccessToken`
 * 4. Server exchanges refresh token for new access token via WorkOS API
 * 5. If refresh token was rotated, server updates stored token
 * 6. New access token returned to client
 *
 * Security features:
 * - Refresh tokens never leave the server after initial storage
 * - Token rotation is handled automatically
 * - Previous refresh tokens are tracked to detect reuse attacks
 * - Revoked tokens are handled gracefully
 */

import { v } from 'convex/values';
import { action, internalMutation, internalQuery, mutation } from './_generated/server';
import { internal } from './_generated/api';
import { hashDeviceSecret, verifyDeviceSecret } from './lib/deviceSecret';

// WorkOS API endpoints
const WORKOS_TOKEN_URL = 'https://api.workos.com/user_management/authenticate';

// Error types for precise error handling
export const AuthErrorCode = {
	NO_SESSION: 'NO_SESSION',
	SESSION_EXPIRED: 'SESSION_EXPIRED',
	TOKEN_REVOKED: 'TOKEN_REVOKED',
	TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
	WORKOS_ERROR: 'WORKOS_ERROR',
	UNAUTHORIZED: 'UNAUTHORIZED',
	INVALID_DEVICE: 'INVALID_DEVICE'
} as const;

type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

class AuthError extends Error {
	constructor(
		public code: AuthErrorCode,
		message: string
	) {
		super(message);
		this.name = 'AuthError';
	}
}

// ============================================================================
// Internal Queries (server-only)
// ============================================================================

/**
 * Get a user's session by userId
 */
export const getSessionByUserId = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('userSessions')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.first();
	}
});

/**
 * Get a user's session by sessionId (from JWT 'sid' claim)
 */
export const getSessionBySessionId = internalQuery({
	args: { sessionId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('userSessions')
			.withIndex('by_sessionId', (q) => q.eq('sessionId', args.sessionId))
			.first();
	}
});

// ============================================================================
// Internal Mutations (server-only)
// ============================================================================

/**
 * Create or update a user session with refresh token
 */
export const upsertSession = internalMutation({
	args: {
		userId: v.string(),
		sessionId: v.string(),
		refreshToken: v.string(),
		previousRefreshToken: v.optional(v.string()),
		deviceSecretHash: v.string()
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		// Check for existing session
		const existing = await ctx.db
			.query('userSessions')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.first();

		if (existing) {
			// Update existing session
			await ctx.db.patch(existing._id, {
				refreshToken: args.refreshToken,
				sessionId: args.sessionId,
				deviceSecretHash: args.deviceSecretHash,
				previousRefreshToken: args.previousRefreshToken ?? existing.refreshToken,
				rotatedAt: args.previousRefreshToken ? now : existing.rotatedAt,
				updatedAt: now
			});
			return existing._id;
		} else {
			// Create new session
			return await ctx.db.insert('userSessions', {
				userId: args.userId,
				sessionId: args.sessionId,
				refreshToken: args.refreshToken,
				deviceSecretHash: args.deviceSecretHash,
				createdAt: now,
				updatedAt: now
			});
		}
	}
});

/**
 * Delete a user session (logout)
 */
export const deleteSession = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query('userSessions')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.first();

		if (session) {
			await ctx.db.delete(session._id);
		}
	}
});

/**
 * Delete session by sessionId
 */
export const deleteSessionBySessionId = internalMutation({
	args: { sessionId: v.string() },
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query('userSessions')
			.withIndex('by_sessionId', (q) => q.eq('sessionId', args.sessionId))
			.first();

		if (session) {
			await ctx.db.delete(session._id);
		}
	}
});

// ============================================================================
// Public Mutations (client-callable)
// ============================================================================

/**
 * Store refresh token after initial login
 *
 * Called by client immediately after successful WorkOS authentication.
 * The refresh token is stored server-side and should be discarded by the client.
 */
export const storeSession = mutation({
	args: {
		refreshToken: v.string(),
		sessionId: v.string(),
		deviceSecret: v.string()
	},
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Not authenticated');
		}

		const deviceSecretHash = await hashDeviceSecret(args.deviceSecret);

		await ctx.db
			.query('userSessions')
			.withIndex('by_userId', (q) => q.eq('userId', identity.subject))
			.first()
			.then(async (existing) => {
				const now = Date.now();
				if (existing) {
					await ctx.db.patch(existing._id, {
						refreshToken: args.refreshToken,
						sessionId: args.sessionId,
						deviceSecretHash,
						updatedAt: now
					});
				} else {
					await ctx.db.insert('userSessions', {
						userId: identity.subject,
						sessionId: args.sessionId,
						refreshToken: args.refreshToken,
						deviceSecretHash,
						createdAt: now,
						updatedAt: now
					});
				}
			});

		return { success: true };
	}
});

/**
 * Logout - revoke session and delete stored tokens
 */
export const logout = mutation({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			// Already logged out
			return { success: true };
		}

		// Delete the session
		const session = await ctx.db
			.query('userSessions')
			.withIndex('by_userId', (q) => q.eq('userId', identity.subject))
			.first();

		if (session) {
			await ctx.db.delete(session._id);
		}

		return { success: true };
	}
});

// ============================================================================
// Actions (can call external APIs)
// ============================================================================

/**
 * Refresh access token using stored refresh token
 *
 * This is the main token refresh endpoint. The client calls this when their
 * access token is expired or about to expire.
 *
 * Returns a new access token. The refresh token rotation is handled internally.
 *
 * @throws AuthError with specific codes for different failure scenarios
 */
export const refreshAccessToken = action({
	args: {
		// Client can optionally provide sessionId for lookup
		// If not provided, we use the current identity
		sessionId: v.optional(v.string()),
		deviceSecret: v.string()
	},
	handler: async (ctx, args): Promise<{ accessToken: string; expiresIn: number }> => {
		// Get current identity to find the session
		const identity = await ctx.auth.getUserIdentity();

		let session;

		if (identity) {
			// Look up by user ID from current identity
			session = await ctx.runQuery(internal.auth.getSessionByUserId, {
				userId: identity.subject
			});
		} else if (args.sessionId) {
			// Look up by session ID
			session = await ctx.runQuery(internal.auth.getSessionBySessionId, {
				sessionId: args.sessionId
			});
		}

		if (!session) {
			throw new AuthError(
				AuthErrorCode.NO_SESSION,
				'No session found. Please log in again.'
			);
		}

		const validSecret = await verifyDeviceSecret(
			args.deviceSecret,
			session.deviceSecretHash
		);
		if (!validSecret) {
			await ctx.runMutation(internal.auth.deleteSession, { userId: session.userId });
			throw new AuthError(AuthErrorCode.INVALID_DEVICE, 'Device verification failed.');
		}

		// Get WorkOS client ID from environment
		const clientId = process.env.WORKOS_CLIENT_ID;
		if (!clientId) {
			throw new Error('WORKOS_CLIENT_ID environment variable not set');
		}

		// Call WorkOS to refresh the token
		const response = await fetch(WORKOS_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				client_id: clientId,
				refresh_token: session.refreshToken
			})
		});

		const data = await response.json();

		// Handle WorkOS error responses
		if (!response.ok) {
			const errorCode = data.error || 'unknown_error';
			const errorDescription = data.error_description || 'Token refresh failed';

			// Check for specific error types
			if (
				errorCode === 'invalid_grant' ||
				errorCode === 'expired_token' ||
				errorDescription.includes('revoked') ||
				errorDescription.includes('expired')
			) {
				// Token has been revoked or expired - delete the session
				await ctx.runMutation(internal.auth.deleteSession, {
					userId: session.userId
				});

				throw new AuthError(
					AuthErrorCode.TOKEN_REVOKED,
					'Session has been revoked. Please log in again.'
				);
			}

			// Check for token reuse (potential attack)
			if (errorDescription.includes('reuse') || errorDescription.includes('already used')) {
				// Possible token reuse attack - delete the session for safety
				await ctx.runMutation(internal.auth.deleteSession, {
					userId: session.userId
				});

				throw new AuthError(
					AuthErrorCode.TOKEN_REUSE_DETECTED,
					'Security alert: Token reuse detected. Please log in again.'
				);
			}

			throw new AuthError(AuthErrorCode.WORKOS_ERROR, `WorkOS error: ${errorDescription}`);
		}

		// Extract tokens from response
		const { access_token, refresh_token: newRefreshToken } = data;

		if (!access_token) {
			throw new AuthError(AuthErrorCode.WORKOS_ERROR, 'No access token in response');
		}

		// Handle refresh token rotation
		// WorkOS may return a new refresh token - we must update our stored token
		if (newRefreshToken && newRefreshToken !== session.refreshToken) {
			await ctx.runMutation(internal.auth.upsertSession, {
				userId: session.userId,
				sessionId: session.sessionId,
				refreshToken: newRefreshToken,
				previousRefreshToken: session.refreshToken,
				deviceSecretHash: session.deviceSecretHash
			});
		}

		// Parse the access token to get expiration
		let expiresIn = 300; // Default 5 minutes
		try {
			const payload = access_token.split('.')[1];
			const decoded = JSON.parse(atob(payload));
			if (decoded.exp && decoded.iat) {
				expiresIn = decoded.exp - decoded.iat;
			}
		} catch {
			// Use default expiration
		}

		return {
			accessToken: access_token,
			expiresIn
		};
	}
});

/**
 * Check if user has a valid session stored
 *
 * Useful for determining if token refresh is possible without actually refreshing.
 */
export const hasValidSession = action({
	args: {},
	handler: async (ctx): Promise<{ hasSession: boolean; sessionId?: string }> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			return { hasSession: false };
		}

		const session = await ctx.runQuery(internal.auth.getSessionByUserId, {
			userId: identity.subject
		});

		return {
			hasSession: !!session,
			sessionId: session?.sessionId
		};
	}
});
