import { query } from './_generated/server';

export const get = query({
	args: {},
	handler: async (ctx) => {
		const config = await ctx.db.query('appConfig').first();
		if (!config) return null;

		const url = await ctx.storage.getUrl(config.heroImage.storageId);

		return {
			...config,
			heroImage: {
				...config.heroImage,
				url: url
			}
		};
	}
});
