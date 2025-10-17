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
