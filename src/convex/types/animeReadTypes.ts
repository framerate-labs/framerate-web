import type { Doc } from '../_generated/dataModel';

export type AniListStudioDoc = {
	anilistStudioId: number;
	name: string;
	isAnimationStudio?: boolean;
	isMain?: boolean;
};

export type AniListMediaDoc = Pick<Doc<'anilistMedia'>, 'anilistId' | 'studios'> & {
	studios?: AniListStudioDoc[];
};
