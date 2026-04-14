import {
	collapseDuplicatesTransformer,
	DataSet,
	englishDataset,
	englishRecommendedTransformers,
	pattern,
	RegExpMatcher,
	resolveConfusablesTransformer,
	resolveLeetSpeakTransformer,
	skipNonAlphabeticTransformer,
	toAsciiLowerCaseTransformer
} from 'obscenity';

const MAX_DISPLAY_NAME_LENGTH = 50;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 20;
const DISPLAY_NAME_PATTERN = /^[^+\-*/=^%&<>!@#,$(){}[\]]*$/;
const USERNAME_PATTERN = /^(?=.*[a-z])[a-z][a-z0-9_-]*$/;
const WHITESPACE_PATTERN = /\s+/g;
const RESERVED_IDENTITY_SEPARATOR_PATTERN = /[_-]+/g;

const reservedIdentityTerms = [
	'admin',
	'administrator',
	'mod',
	'moderator',
	'staff',
	'support',
	'official',
	'team',
	'framerate',
	'frame rate'
] as const;

const blacklistDataSet = new DataSet<{ originalWord: string }>()
	.addAll(englishDataset)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'admin' })
			.addPattern(pattern`admin`)
			.addPattern(pattern`admn`)
			.addPattern(pattern`ad min`)
			.addPattern(pattern`adm in`)
			.addPattern(pattern`a dmin`)
			.addPattern(pattern`admi n`)
	)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'moderator' })
			.addPattern(pattern`moderator`)
			.addPattern(pattern`mod`)
			.addPattern(pattern`moder ator`)
			.addPattern(pattern`m0d`)
	)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'staff' })
			.addPattern(pattern`staff`)
			.addPattern(pattern`st aff`)
	)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'support' })
			.addPattern(pattern`support`)
			.addPattern(pattern`sup port`)
	)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'official' })
			.addPattern(pattern`official`)
			.addPattern(pattern`off icial`)
	)
	.addPhrase((phrase) =>
		phrase
			.setMetadata({ originalWord: 'framerate' })
			.addPattern(pattern`framerate`)
			.addPattern(pattern`frame rate`)
	);

const blacklistMatcher = new RegExpMatcher({
	...blacklistDataSet.build(),
	...englishRecommendedTransformers,
	blacklistMatcherTransformers: [
		collapseDuplicatesTransformer(),
		resolveConfusablesTransformer(),
		resolveLeetSpeakTransformer(),
		skipNonAlphabeticTransformer(),
		toAsciiLowerCaseTransformer()
	]
});

function trimToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function collapseWhitespace(value: string): string {
	return value.replace(WHITESPACE_PATTERN, ' ');
}

function normalizeSearchText(value: string): string {
	return value.trim().toLowerCase();
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
	return trimToNull(value);
}

export function normalizeDisplayNameForStorage(value: string | null | undefined): string {
	const trimmed = trimToNull(value);
	if (!trimmed) {
		throw new Error('Display name must be at least 1 character.');
	}
	const normalized = collapseWhitespace(trimmed);
	if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
		throw new Error(`Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
	}
	if (!DISPLAY_NAME_PATTERN.test(normalized)) {
		throw new Error('Display name cannot contain special characters.');
	}
	ensureIdentityTextAllowed(normalized, 'Display name');
	return normalized;
}

export function normalizeDisplayNameForSearch(value: string): string {
	return normalizeSearchText(value);
}

export function normalizeUsernameForStorage(value: string | null | undefined): string | null {
	const trimmed = normalizeSearchText(value ?? '');
	if (trimmed.length === 0) return null;
	if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) {
		throw new Error(
			`Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`
		);
	}
	if (!USERNAME_PATTERN.test(trimmed)) {
		throw new Error(
			'Username must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores.'
		);
	}
	ensureIdentityTextAllowed(trimmed, 'Username');
	return trimmed;
}

export function ensureIdentityTextAllowed(value: string, fieldName: string): void {
	if (blacklistMatcher.hasMatch(value) || containsReservedIdentityTerm(value)) {
		throw new Error(`${fieldName} cannot include profanity or impersonate FrameRate staff.`);
	}
}

function containsReservedIdentityTerm(value: string): boolean {
	const normalized = collapseWhitespace(
		normalizeSearchText(value).replace(RESERVED_IDENTITY_SEPARATOR_PATTERN, ' ')
	);
	return reservedIdentityTerms.some((term) => normalized.includes(term));
}
