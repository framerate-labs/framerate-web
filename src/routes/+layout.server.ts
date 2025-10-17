import type { LayoutServerLoad } from './$types';

import { getServerSession } from '$lib/auth-server';

export const load: LayoutServerLoad = async ({ request }) => {
	const user = await getServerSession(request);

	return {
		user
	};
};
