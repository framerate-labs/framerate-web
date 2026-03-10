import type { AniListMediaCore } from '../../types/animeTypes';
import type { StoredCastCredit, StoredCrewCredit } from '../../types/detailsType';

export type CreditCoverage = 'preview' | 'full';
export type CreditSource = 'tmdb' | 'anilist';
export type CharacterOverrideScope = 'media_character' | 'global_character';

export const CREDIT_PREVIEW_LIMIT = 10;
export const CREDIT_MAX_ITEMS = 100;

function sanitizeName(value: string | null | undefined): string {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : '';
}

export function coverageRank(coverage: CreditCoverage): number {
	return coverage === 'full' ? 2 : 1;
}

export function deriveCoverageFromPreviewTotals(
	castTotal: number,
	crewTotal: number
): CreditCoverage {
	return castTotal <= CREDIT_PREVIEW_LIMIT && crewTotal <= CREDIT_PREVIEW_LIMIT ? 'full' : 'preview';
}

export function clampCreditRows<T>(rows: T[], maxItems = CREDIT_MAX_ITEMS): T[] {
	if (rows.length <= maxItems) return rows;
	return rows.slice(0, maxItems);
}

export function asPreviewRows<T>(rows: T[], limit = CREDIT_PREVIEW_LIMIT): T[] {
	if (rows.length <= limit) return rows;
	return rows.slice(0, limit);
}

export function toAniListCastCreditsFromMedia(media: AniListMediaCore): StoredCastCredit[] {
	const rows = media.characters ?? [];
	const mapped: Array<StoredCastCredit | null> = rows
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((row) => {
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
				adult: false as boolean,
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
		});
	return mapped.filter((row): row is StoredCastCredit => row !== null);
}

export function toAniListCrewCreditsFromMedia(media: AniListMediaCore): StoredCrewCredit[] {
	const rows = media.staff ?? [];
	const mapped: Array<StoredCrewCredit | null> = rows
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((row) => {
			const staffName = sanitizeName(row.name);
			if (staffName.length === 0) return null;
			const department = sanitizeName(row.department);
			const role = sanitizeName(row.role);
			return {
				id: row.anilistStaffId,
				adult: false as boolean,
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
		});
	return mapped.filter((row): row is StoredCrewCredit => row !== null);
}

export function creditCharacterKey(source: CreditSource, creditId: string): string {
	if (source === 'anilist') {
		const parts = creditId.split(':');
		if (parts.length >= 3) {
			return `anilist:${parts[1]}:${parts[2]}`;
		}
	}
	return `${source}:${creditId}`;
}
