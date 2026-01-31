/**
 * HTTP Routes for FrameRate API
 *
 * These endpoints can be called directly via HTTP without the Convex SDK.
 * This is critical for token refresh when the SDK may be in a bad auth state.
 */

import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { verifyDeviceSecret } from './lib/deviceSecret';

const http = httpRouter();

// WorkOS API endpoint
const WORKOS_TOKEN_URL = 'https://api.workos.com/user_management/authenticate';

/**
 * POST /api/auth/refresh
 *
 * Refreshes an access token using a stored session.
 * This endpoint does NOT require a valid JWT - it uses sessionId to look up the refresh token.
 *
 * Request body: { sessionId: string }
 * Response: { accessToken: string, expiresIn: number } or { error: string, code: string }
 */
http.route({
	path: '/api/auth/refresh',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		try {
			// Parse request body
			const body = await request.json();
			const sessionId = body?.sessionId;
			const deviceSecret = body?.deviceSecret;

			if (!sessionId || typeof sessionId !== 'string') {
				return new Response(JSON.stringify({ error: 'sessionId is required', code: 'INVALID_REQUEST' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (!deviceSecret || typeof deviceSecret !== 'string') {
				return new Response(JSON.stringify({ error: 'deviceSecret is required', code: 'INVALID_DEVICE' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Look up session by sessionId
			const session = await ctx.runQuery(internal.auth.getSessionBySessionId, { sessionId });

			if (!session) {
				return new Response(JSON.stringify({ error: 'No session found', code: 'NO_SESSION' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (!session.deviceSecretHash) {
				await ctx.runMutation(internal.auth.deleteSession, { userId: session.userId });
				return new Response(JSON.stringify({ error: 'Device verification failed', code: 'INVALID_DEVICE' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			const validDevice = await verifyDeviceSecret(deviceSecret, session.deviceSecretHash);
			if (!validDevice) {
				await ctx.runMutation(internal.auth.deleteSession, { userId: session.userId });
				return new Response(JSON.stringify({ error: 'Device verification failed', code: 'INVALID_DEVICE' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Get WorkOS client ID
			const clientId = process.env.WORKOS_CLIENT_ID;
			if (!clientId) {
				return new Response(JSON.stringify({ error: 'Server configuration error', code: 'SERVER_ERROR' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Call WorkOS to refresh the token
			const workosResponse = await fetch(WORKOS_TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: clientId,
					refresh_token: session.refreshToken
				})
			});

			const data = await workosResponse.json();

			// Handle WorkOS errors
			if (!workosResponse.ok) {
				const errorCode = data.error || 'unknown_error';
				const errorDescription = data.error_description || 'Token refresh failed';

				// Check for revoked/expired tokens
				if (
					errorCode === 'invalid_grant' ||
					errorCode === 'expired_token' ||
					errorDescription.includes('revoked') ||
					errorDescription.includes('expired')
				) {
					// Delete the invalid session
					await ctx.runMutation(internal.auth.deleteSession, { userId: session.userId });

					return new Response(JSON.stringify({ error: 'Session revoked', code: 'TOKEN_REVOKED' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				return new Response(JSON.stringify({ error: errorDescription, code: 'WORKOS_ERROR' }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			const { access_token, refresh_token: newRefreshToken } = data;

			if (!access_token) {
				return new Response(JSON.stringify({ error: 'No access token in response', code: 'WORKOS_ERROR' }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Handle refresh token rotation
			if (newRefreshToken && newRefreshToken !== session.refreshToken) {
				await ctx.runMutation(internal.auth.upsertSession, {
					userId: session.userId,
					sessionId: session.sessionId,
					refreshToken: newRefreshToken,
					previousRefreshToken: session.refreshToken,
					deviceSecretHash: session.deviceSecretHash
				});
			}

			// Parse expiration from access token
			let expiresIn = 300; // Default 5 minutes
			try {
				const payload = access_token.split('.')[1];
				const decoded = JSON.parse(atob(payload));
				if (decoded.exp && decoded.iat) {
					expiresIn = decoded.exp - decoded.iat;
				}
			} catch {
				// Use default
			}

			return new Response(JSON.stringify({ accessToken: access_token, expiresIn }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			console.error('Token refresh error:', error);
			return new Response(JSON.stringify({ error: 'Internal server error', code: 'SERVER_ERROR' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	})
});

export default http;
