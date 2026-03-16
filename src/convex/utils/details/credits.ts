export type CreditCoverage = 'preview' | 'full';
export type CreditSource = 'tmdb' | 'anilist';
export type CharacterOverrideScope = 'media_character' | 'global_character';

export const CREDIT_PREVIEW_LIMIT = 10;
export const CREDIT_MAX_ITEMS = 200;

const GENERIC_CHARACTER_NOUNS = new Set([
	'boy',
	'girl',
	'man',
	'woman',
	'person',
	'human',
	'child',
	'children',
	'grandson',
	'granddaughter',
	'grandaughter',
	'grandchild',
	'grandchildren',
	'mother',
	'father',
	'grandmother',
	'grandfather',
	'soldier',
	'guard',
	'guardsman',
	'watchman',
	'client',
	'curse',
	'nobleman',
	'noblewoman',
	'knight',
	'captain',
	'merchant',
	'spectator',
	'student',
	'farrier',
	'doctor',
	'armorer',
	'maester',
	'musician',
	'herald',
	'announcement',
	'station',
	'septon',
	'recruit',
	'comrade',
	'leader',
	'member',
	'executive',
	'instructor',
	'subordinate'
]);

function normalizeCharacterTokens(character: string): string[] {
	return character
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function normalizeGenericToken(token: string): string {
	if (token.endsWith('s') && token.length > 3) {
		return token.slice(0, -1);
	}
	return token;
}

export function isGenericCharacterLabel(character: string): boolean {
	const tokens = normalizeCharacterTokens(character);
	if (tokens.length === 0) return true;
	for (const token of tokens) {
		if (GENERIC_CHARACTER_NOUNS.has(normalizeGenericToken(token))) {
			return true;
		}
	}
	return false;
}

export function prioritizeSpecificCastRows<T extends { character: string }>(rows: T[]): T[] {
	if (rows.length < 2) return rows;
	const prioritized: T[] = [];
	const deprioritized: T[] = [];
	for (const row of rows) {
		if (isGenericCharacterLabel(row.character)) {
			deprioritized.push(row);
		} else {
			prioritized.push(row);
		}
	}
	if (deprioritized.length === 0 || prioritized.length === 0) return rows;
	return prioritized.concat(deprioritized);
}

export function coverageRank(coverage: CreditCoverage): number {
	return coverage === 'full' ? 2 : 1;
}

export function clampCreditRows<T>(rows: T[], maxItems = CREDIT_MAX_ITEMS): T[] {
	if (rows.length <= maxItems) return rows;
	return rows.slice(0, maxItems);
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
