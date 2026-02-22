import type { getMovieBySource, getTVShowBySource } from '../utils/mediaLookup';

export type MovieMedia = NonNullable<Awaited<ReturnType<typeof getMovieBySource>>>;
export type TVMedia = NonNullable<Awaited<ReturnType<typeof getTVShowBySource>>>;

export type ResolvedMedia =
	| { mediaType: 'movie'; media: MovieMedia }
	| { mediaType: 'tv'; media: TVMedia };

export type ReviewSnapshot = {
	liked: boolean;
	watched: boolean;
	review: string | null;
	rating: string;
	createdAt: number;
};
