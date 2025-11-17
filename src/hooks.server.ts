import type { Handle } from '@sveltejs/kit';

import { redirect } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	const sessionToken =
		event.cookies.get('framerate.session_token') ||
		event.cookies.get('__Secure-framerate.session_token');

	// If user is authenticated and visiting root, redirect to /home
	if (sessionToken && event.url.pathname === '/') {
		throw redirect(303, '/home');
	}

	return resolve(event);
};
