import type { LayoutServerLoad } from './$types';

import { getServerSession } from '$lib/auth-server';

export const load: LayoutServerLoad = async ({ request }) => {
	const user = await getServerSession(request);

	console.log('[Layout Server] User session:', {
		exists: !!user,
		hasName: !!user?.name,
		hasEmail: !!user?.email,
		hasUsername: !!user?.username,
		userData: user ? JSON.stringify(user) : 'null'
	});

	if (!user) {
		return {
			user: null
		};
	}

	return {
		user: { ...user, isLoggedIn: true }
	};
};
