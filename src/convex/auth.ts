/**
 * Authentication and Session Management
 *
 * This module handles secure token refresh with WorkOS.
 * Refresh tokens are stored server-side and never sent to the client after initial login.
 *
 * Flow:
 * 1. Client authenticates with WorkOS, receives access + refresh tokens
 * 2. Client calls `storeSession` to securely store refresh token in Convex
 * 3. When access token expires, client calls `/api/auth/refresh`
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

import type { AuthErrorCodeValue } from './types/authTypes';

import { v } from 'convex/values';

import { internalMutation, internalQuery, mutation } from './_generated/server';
import { hashDeviceSecret } from './utils/deviceSecret';

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

class AuthError extends Error {
	constructor(
		public code: AuthErrorCodeValue,
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
