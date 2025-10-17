import { usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/svelte';

import { dev } from '$app/environment';
import { PUBLIC_AUTH_ORIGIN } from '$env/static/public';

const baseURL = PUBLIC_AUTH_ORIGIN || (dev ? 'http://localhost:8000' : 'https://api.frame-rate.io');

export const authClient = createAuthClient({
	baseURL,
	fetchOptions: { credentials: 'include' },
	plugins: [usernameClient()]
});
