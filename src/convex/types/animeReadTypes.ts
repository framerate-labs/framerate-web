import type { Doc } from '../_generated/dataModel';

export type AniListStudioDoc = {
	anilistStudioId: number;
	name: string;
	isAnimationStudio?: boolean;
	isMain?: boolean;
};

export type AniListCharacterVoiceActorDoc = {
	anilistStaffId: number;
	name: string;
	imageUrl: string | null;
};

export type AniListCharacterDoc = {
	anilistCharacterId: number;
	name: string;
	imageUrl: string | null;
	role: string | null;
	voiceActor?: AniListCharacterVoiceActorDoc | null;
	order: number;
};

export type AniListStaffDoc = {
	anilistStaffId: number;
	name: string;
	imageUrl: string | null;
	role: string | null;
	department: string | null;
	order: number;
};

export type AniListMediaDoc = Pick<
	Doc<'anilistMedia'>,
	'anilistId' | 'studios' | 'characters' | 'staff'
> & {
	studios?: AniListStudioDoc[];
	characters?: AniListCharacterDoc[];
	staff?: AniListStaffDoc[];
};
