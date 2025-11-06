import type { App } from '@framerate/server';

import { treaty } from '@elysiajs/eden';

import { dev } from '$app/environment';

export const apiBaseUrl = dev ? 'http://localhost:8000' : 'https://api.frame-rate.io';

export const client = treaty<App>(apiBaseUrl, {
	fetch: {
		credentials: 'include',
		mode: 'cors',
		redirect: 'follow',
		referrerPolicy: 'no-referrer'
	}
});

/**
 * Create a server-side client that forwards cookies from a SvelteKit request.
 * Use this in +page.server.ts actions to ensure authentication cookies are sent.
 */
export function createServerClient(request: Request) {
	const cookieHeader = request.headers.get('cookie');

	return treaty<App>(apiBaseUrl, {
		headers: cookieHeader ? { cookie: cookieHeader } : {},
		fetch: {
			credentials: 'include',
			mode: 'cors',
			redirect: 'follow',
			referrerPolicy: 'no-referrer'
		}
	});
}
