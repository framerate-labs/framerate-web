import type { QueryCtx } from '../../_generated/server';
import type {
	AniListCharacterDoc,
	AniListMediaDoc,
	AniListStaffDoc,
	AniListStudioDoc
} from '../../types/animeReadTypes';
import type {
	HeaderContributorInput,
	StoredCastCredit,
	StoredCrewCredit
} from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';

function scoreStudio(studio: AniListStudioDoc): number {
	return (studio.isAnimationStudio ? 4 : 0) + (studio.isMain ? 2 : 0);
}

function sortPreferredStudios(studios: AniListStudioDoc[]): AniListStudioDoc[] {
	return [...studios].sort((a, b) => {
		const scoreDelta = scoreStudio(b) - scoreStudio(a);
		if (scoreDelta !== 0) return scoreDelta;
		return a.name.localeCompare(b.name);
	});
}

export function toStudioCredits(media: AniListMediaDoc | null): HeaderContributorInput[] | null {
	if (!media?.studios || media.studios.length === 0) return null;
	const preferred = sortPreferredStudios(media.studios);
	const topScore = scoreStudio(preferred[0]!);
	const selected = preferred.filter((studio) => scoreStudio(studio) === topScore);
	const credits = selected
		.map((studio) => ({
			type: 'company' as const,
			tmdbId: null,
			name: studio.name.trim(),
			role: 'studio',
			source: 'anilist' as const,
			sourceId: studio.anilistStudioId,
			matchMethod: null,
			matchConfidence: null
		}))
		.filter((studio) => studio.name.length > 0);
	return credits.length > 0 ? credits : null;
}

export async function getAniListMediaById(
	ctx: QueryCtx,
	anilistId: number
): Promise<AniListMediaDoc | null> {
	const row = await ctx.db
		.query('anilistMedia')
		.withIndex('by_anilistId', (q) => q.eq('anilistId', anilistId))
		.unique();
	return row ? (row as AniListMediaDoc) : null;
}

export async function getAnimeXrefByTMDB(
	ctx: QueryCtx,
	args: { tmdbType: MediaType; tmdbId: number }
) {
	const row = await ctx.db
		.query('animeXref')
		.withIndex('by_tmdbType_tmdbId', (q) =>
			q.eq('tmdbType', args.tmdbType).eq('tmdbId', args.tmdbId)
		)
		.unique();
	return row ?? null;
}

function sanitizeName(value: string | null | undefined): string {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : '';
}

function toAniListCastCredit(row: AniListCharacterDoc): StoredCastCredit | null {
	const characterName = sanitizeName(row.name);
	if (characterName.length === 0) return null;
	const voiceActorName = sanitizeName(row.voiceActor?.name);
	const characterRole = sanitizeName(row.role);
	const characterLabel =
		voiceActorName.length > 0
			? `Voice: ${voiceActorName}`
			: characterRole.length > 0
				? characterRole
				: 'Character';
	return {
		id: row.voiceActor?.anilistStaffId ?? -Math.abs(row.anilistCharacterId),
		adult: false,
		gender: 0,
		knownForDepartment: 'Character',
		name: characterName,
		originalName: characterName,
		popularity: 0,
		profilePath: row.imageUrl ?? null,
		character: characterLabel,
		creditId: `anilist:character:${row.anilistCharacterId}`,
		order: row.order,
		castId: null
	};
}

function toAniListCrewCredit(row: AniListStaffDoc): StoredCrewCredit | null {
	const staffName = sanitizeName(row.name);
	if (staffName.length === 0) return null;
	const department = sanitizeName(row.department);
	const role = sanitizeName(row.role);
	return {
		id: row.anilistStaffId,
		adult: false,
		gender: 0,
		knownForDepartment: department.length > 0 ? department : 'Production',
		name: staffName,
		originalName: staffName,
		popularity: 0,
		profilePath: row.imageUrl ?? null,
		creditId: `anilist:staff:${row.anilistStaffId}:${row.order}`,
		department: department.length > 0 ? department : 'Production',
		job: role.length > 0 ? role : 'Staff'
	};
}

export function toAniListCastCredits(media: AniListMediaDoc | null): StoredCastCredit[] | null {
	const rows = media?.characters ?? [];
	if (rows.length === 0) return null;
	const credits = rows
		.slice()
		.sort((a, b) => a.order - b.order)
		.map(toAniListCastCredit)
		.filter((row): row is StoredCastCredit => row !== null);
	return credits.length > 0 ? credits : null;
}

export function toAniListCrewCredits(media: AniListMediaDoc | null): StoredCrewCredit[] | null {
	const rows = media?.staff ?? [];
	if (rows.length === 0) return null;
	const credits = rows
		.slice()
		.sort((a, b) => a.order - b.order)
		.map(toAniListCrewCredit)
		.filter((row): row is StoredCrewCredit => row !== null);
	return credits.length > 0 ? credits : null;
}
