import type {
	EnrichmentCompanyInput,
	HeaderContributorInput,
	HeaderContributorSource
} from '../../types/detailsType';
import type { NormalizedMediaDetails } from '../../types/tmdb/detailsTypes';

import { buildCreatorCredits as buildCreatorCreditsInternal } from './animeEnrichment';

function normalizeCreditName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function creatorCreditIdentityKey(contributor: HeaderContributorInput): string {
	const source = contributor.source ?? 'tmdb';
	const sourceId = contributor.sourceId ?? null;
	const normalizedName = normalizeCreditName(contributor.name);
	return [
		source,
		contributor.type,
		contributor.role ?? '',
		sourceId ?? 'none',
		contributor.tmdbId ?? normalizedName
	].join(':');
}

function bestTMDBStudioByName(
	credits: HeaderContributorInput[],
	name: string
): { credit: HeaderContributorInput; method: 'normalized' | 'fuzzy'; confidence: number } | null {
	const target = normalizeCreditName(name);

	for (const credit of credits) {
		if ((credit.source ?? 'tmdb') !== 'tmdb') continue;
		if (credit.type !== 'company') continue;
		if (credit.role !== 'studio') continue;
		if (credit.tmdbId === null) continue;
		const candidate = normalizeCreditName(credit.name);
		if (candidate === target) {
			return { credit, method: 'normalized', confidence: 1 };
		}
	}

	for (const credit of credits) {
		if ((credit.source ?? 'tmdb') !== 'tmdb') continue;
		if (credit.type !== 'company') continue;
		if (credit.role !== 'studio') continue;
		if (credit.tmdbId === null) continue;
		const candidate = normalizeCreditName(credit.name);
		if (candidate.includes(target) || target.includes(candidate)) {
			return { credit, method: 'fuzzy', confidence: 0.8 };
		}
	}

	return null;
}

function attachTMDBCompanyMatchToAniListStudio(
	incoming: HeaderContributorInput,
	existingCredits: HeaderContributorInput[]
): HeaderContributorInput {
	if ((incoming.source ?? 'tmdb') !== 'anilist') return incoming;
	if (incoming.type !== 'company' || incoming.role !== 'studio') return incoming;
	if (incoming.matchMethod === 'manual') return incoming;

	const match = bestTMDBStudioByName(existingCredits, incoming.name);
	if (!match || match.credit.tmdbId === null) {
		return {
			...incoming,
			matchMethod: incoming.matchMethod ?? null,
			matchConfidence: incoming.matchConfidence ?? null
		};
	}

	return {
		...incoming,
		tmdbId: match.credit.tmdbId,
		matchMethod: match.method,
		matchConfidence: match.confidence
	};
}

export function dedupeCreatorCredits(
	contributors: HeaderContributorInput[]
): HeaderContributorInput[] {
	const seen = new Set<string>();
	const unique: HeaderContributorInput[] = [];
	for (const contributor of contributors) {
		const normalizedName = contributor.name.trim();
		if (normalizedName.length === 0) continue;
		const source = contributor.source ?? 'tmdb';
		const sourceId = contributor.sourceId ?? null;
		const key = `${source}:${contributor.type}:${sourceId ?? 'none'}:${contributor.tmdbId ?? normalizedName.toLowerCase()}:${contributor.role ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ ...contributor, source, sourceId, name: normalizedName });
	}
	return unique;
}

export function mergeCreatorCreditsForSource(
	existing: HeaderContributorInput[] | null | undefined,
	incoming: HeaderContributorInput[] | null | undefined,
	source: HeaderContributorSource
): HeaderContributorInput[] {
	const existingList = dedupeCreatorCredits(existing ?? []);
	const incomingList = dedupeCreatorCredits(incoming ?? []);
	const otherSourceCredits = existingList.filter((credit) => (credit.source ?? 'tmdb') !== source);
	const existingSourceCredits = existingList.filter(
		(credit) => (credit.source ?? 'tmdb') === source
	);
	const existingSourceByIdentity = new Map(
		existingSourceCredits.map((credit) => [creatorCreditIdentityKey(credit), credit] as const)
	);

	const preparedIncoming = incomingList
		.map((credit) =>
			source === 'anilist' ? attachTMDBCompanyMatchToAniListStudio(credit, existingList) : credit
		)
		.map((credit) => {
			const existingCredit = existingSourceByIdentity.get(creatorCreditIdentityKey(credit));
			if (!existingCredit || existingCredit.matchMethod !== 'manual') return credit;
			return { ...existingCredit };
		});

	const incomingKeys = new Set(preparedIncoming.map(creatorCreditIdentityKey));
	const preservedManual = existingSourceCredits.filter(
		(credit) =>
			credit.matchMethod === 'manual' && !incomingKeys.has(creatorCreditIdentityKey(credit))
	);

	return dedupeCreatorCredits([...otherSourceCredits, ...preservedManual, ...preparedIncoming]);
}

export function buildCreatorCredits(
	details: NormalizedMediaDetails,
	isAnime: boolean,
	companies: EnrichmentCompanyInput[]
): HeaderContributorInput[] {
	return buildCreatorCreditsInternal(details, isAnime, companies, dedupeCreatorCredits);
}

export function cloneCreatorCredits(
	contributors: ReadonlyArray<{
		type: 'person' | 'company';
		tmdbId: number | null;
		name: string;
		role: string | null;
		source?: HeaderContributorSource;
		sourceId?: number | null;
		matchMethod?: HeaderContributorInput['matchMethod'];
		matchConfidence?: number | null;
	}>
): HeaderContributorInput[] {
	return contributors.map((contributor) => ({
		type: contributor.type,
		tmdbId: contributor.tmdbId,
		name: contributor.name,
		role: contributor.role,
		source: contributor.source ?? 'tmdb',
		sourceId: contributor.sourceId ?? null,
		matchMethod: contributor.matchMethod ?? null,
		matchConfidence: contributor.matchConfidence ?? null
	}));
}
