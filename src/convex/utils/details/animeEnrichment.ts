import type {
	EnrichmentCompanyInput,
	HeaderContributorInput,
	PreparedDetailSync,
	StoredMediaSnapshot
} from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';
import type { NormalizedMediaDetails } from '../../types/tmdb/detailsTypes';

function dedupeCompanies(companies: EnrichmentCompanyInput[]): EnrichmentCompanyInput[] {
	const seen = new Set<number>();
	const unique: EnrichmentCompanyInput[] = [];
	for (const company of companies) {
		if (seen.has(company.tmdbId)) continue;
		seen.add(company.tmdbId);
		unique.push(company);
	}
	return unique;
}

const ANIME_STUDIO_DENYLIST_PENALTIES: Array<{ pattern: string; penalty: number }> = [
	{ pattern: 'kodansha', penalty: 1200 },
	{ pattern: 'dentsu', penalty: 1200 },
	{ pattern: 'pony canyon', penalty: 900 },
	{ pattern: 'aniplex', penalty: 900 },
	{ pattern: 'kadokawa', penalty: 900 },
	{ pattern: 'shueisha', penalty: 900 },
	{ pattern: 'toho', penalty: 700 },
	{ pattern: 'mbs', penalty: 800 },
	{ pattern: 'nhk', penalty: 800 },
	{ pattern: 'tokyo mx', penalty: 800 }
];

function normalizedCompanyName(name: string): string {
	return name.trim().toLowerCase();
}

function animeStudioPenalty(company: EnrichmentCompanyInput): number {
	const normalized = normalizedCompanyName(company.name);
	let penalty = 0;
	for (const entry of ANIME_STUDIO_DENYLIST_PENALTIES) {
		if (normalized.includes(entry.pattern)) penalty += entry.penalty;
	}
	return penalty;
}

function toStudioCredit(company: EnrichmentCompanyInput): HeaderContributorInput {
	return {
		type: 'company',
		tmdbId: company.tmdbId,
		name: company.name,
		role: 'studio',
		source: 'tmdb',
		sourceId: company.tmdbId
	};
}

function pickStudioCandidates(
	companies: EnrichmentCompanyInput[],
	isAnime: boolean,
	maxCount = 1
): HeaderContributorInput[] {
	if (companies.length === 0 || maxCount <= 0) return [];

	if (isAnime) {
		const ranked = [...companies]
			.filter((company) => company.originCountry === 'JP')
			.map((company, index) => ({
				company,
				score: 10_000 - animeStudioPenalty(company) - (company.billingOrder ?? index)
			}))
			.sort((left, right) => {
				if (right.score !== left.score) return right.score - left.score;
				return left.company.billingOrder - right.company.billingOrder;
			})
			.map((entry) => entry.company);
		if (ranked.length > 0) {
			return ranked.slice(0, maxCount).map(toStudioCredit);
		}
	}

	const first = companies[0];
	if (!first) return [];
	return [toStudioCredit(first)];
}

export function shouldRetryDueToPotentialRegression(
	mediaType: MediaType,
	stored: StoredMediaSnapshot | null,
	prepared: PreparedDetailSync
): boolean {
	if (stored === null) return false;

	if (
		stored.releaseDate !== null &&
		stored.releaseDate !== undefined &&
		prepared.details.releaseDate === null
	) {
		return true;
	}
	if (
		stored.overview !== null &&
		stored.overview !== undefined &&
		prepared.details.overview === null
	) {
		return true;
	}

	if (mediaType === 'movie' && prepared.details.mediaType === 'movie') {
		if (
			stored.runtime !== null &&
			stored.runtime !== undefined &&
			prepared.details.runtime === null
		) {
			return true;
		}
	} else if (mediaType === 'tv' && prepared.details.mediaType === 'tv') {
		if (
			stored.lastAirDate !== null &&
			stored.lastAirDate !== undefined &&
			prepared.details.lastAirDate === null
		) {
			return true;
		}
		if (
			stored.lastEpisodeToAir !== null &&
			stored.lastEpisodeToAir !== undefined &&
			prepared.details.lastEpisodeToAir === null
		) {
			return true;
		}
		if (
			stored.nextEpisodeToAir !== null &&
			stored.nextEpisodeToAir !== undefined &&
			prepared.details.nextEpisodeToAir === null
		) {
			return true;
		}
	}

	if ((stored.creatorCredits ?? []).length > 0 && prepared.creatorCredits.length === 0) {
		return true;
	}

	return false;
}

export function shouldRetryDueToSparseInitialPayload(prepared: PreparedDetailSync): boolean {
	const missingOverview =
		prepared.details.overview === null || prepared.details.overview.trim().length === 0;
	const missingTitle = prepared.details.title.trim().length === 0;
	const missingCredits = prepared.creatorCredits.length === 0;
	return missingOverview && missingTitle && missingCredits;
}

export function computeIsAnime(details: NormalizedMediaDetails): boolean {
	const hasAnimationGenre = details.genres.some(
		(genre) => genre.id === 16 || genre.name.toLowerCase() === 'animation'
	);
	const hasJapaneseOriginalLanguage = details.originalLanguage === 'ja';
	const hasJapaneseOrigin = details.originCountry.includes('JP');
	return hasAnimationGenre && hasJapaneseOriginalLanguage && hasJapaneseOrigin;
}

export function buildCompanies(details: NormalizedMediaDetails): EnrichmentCompanyInput[] {
	return dedupeCompanies(
		details.productionCompanies.map((company, index) => ({
			tmdbId: company.id,
			name: company.name,
			logoPath: company.logoPath,
			originCountry: company.originCountry.trim() === '' ? null : company.originCountry,
			role: 'production',
			billingOrder: index
		}))
	);
}

export function buildCreatorCredits(
	details: NormalizedMediaDetails,
	isAnime: boolean,
	companies: EnrichmentCompanyInput[],
	dedupeCreatorCredits: (contributors: HeaderContributorInput[]) => HeaderContributorInput[]
): HeaderContributorInput[] {
	const studioCandidates = isAnime ? pickStudioCandidates(companies, true, 3) : [];
	const isPlaceholderCreatorName = (name: string) => name.trim().toLowerCase() === 'unknown';

	if (details.mediaType === 'movie') {
		const directors = dedupeCreatorCredits(
			details.directorList.map((director) => ({
				type: 'person' as const,
				tmdbId: director.id,
				name: director.name,
				role: 'director',
				source: 'tmdb' as const,
				sourceId: director.id
			}))
		);
		const directorFallback =
			directors.length > 0
				? directors
				: dedupeCreatorCredits(
							details.director
								.split(',')
								.map((name) => name.trim())
								.filter((name) => name.length > 0 && !isPlaceholderCreatorName(name))
								.map((name) => ({
								type: 'person' as const,
								tmdbId: null,
								name,
								role: 'director',
								source: 'tmdb' as const,
								sourceId: null
							}))
					);

		if (isAnime && studioCandidates.length > 0) {
			return dedupeCreatorCredits([...studioCandidates, ...directorFallback]);
		}

		return directorFallback;
	}

	if (isAnime && studioCandidates.length > 0) {
		return dedupeCreatorCredits(studioCandidates);
	}

	const creators = dedupeCreatorCredits(
		details.creatorList.map((creator) => ({
			type: 'person' as const,
			tmdbId: creator.id,
			name: creator.name,
			role: 'creator',
			source: 'tmdb' as const,
			sourceId: creator.id
		}))
	);
	if (creators.length > 0) return creators;

	return dedupeCreatorCredits(
		details.creator
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name.length > 0 && !isPlaceholderCreatorName(name))
			.map((name) => ({
				type: 'person' as const,
				tmdbId: null,
				name,
				role: 'creator',
				source: 'tmdb' as const,
				sourceId: null
			}))
	);
}
