import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return new Response(null, {
		status: 302,
		headers: {
			Location: 'meridian-labs-framerate://auth/logout'
		}
	});
};
