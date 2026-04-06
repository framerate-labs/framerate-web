import type { QueryCtx } from '../../_generated/server';
import type { CreditCacheSnapshot, CreditSource, StoredMediaSnapshot } from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';

import { getCreditCacheBySourceHandler } from './creditCacheHandlers';
import { getStoredMediaHandler } from './mediaHandlers';

export async function getDetailRefreshSnapshotHandler(
	ctx: QueryCtx,
	args: {
		mediaType: MediaType;
		source: 'tmdb' | 'trakt' | 'imdb';
		externalId: number;
		creditSource: CreditSource;
		seasonKey?: string | null;
	}
): Promise<{
	storedMedia: StoredMediaSnapshot | null;
	creditCache: CreditCacheSnapshot | null;
}> {
	const [storedMedia, creditCache] = await Promise.all([
		getStoredMediaHandler(ctx, {
			mediaType: args.mediaType,
			source: args.source,
			externalId: args.externalId
		}),
		getCreditCacheBySourceHandler(ctx, {
			mediaType: args.mediaType,
			tmdbId: args.externalId,
			source: args.creditSource,
			seasonKey: args.seasonKey
		})
	]);

	return {
		storedMedia,
		creditCache
	};
}
