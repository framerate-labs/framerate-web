import type {
	DetailRefreshDecision,
	EnrichmentCompanyInput,
	HeaderContributorInput,
	PreparedDetailSync,
	StoredEpisodeSummary,
	StoredMediaSnapshot,
	SyncPolicy
} from '../types/detailsType';
import type { MediaType } from '../types/mediaTypes';
import type { NormalizedMediaDetails } from '../types/tmdb/detailsTypes';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function isMissingValue(value: unknown): boolean {
	return value === null || value === undefined;
}

export function shouldApplySyncPolicy(
	policy: SyncPolicy,
	currentValue: unknown,
	incomingValue: unknown,
	options?: { treatUnknownAsMissing?: boolean }
): boolean {
	const currentIsUnknown =
		options?.treatUnknownAsMissing === true &&
		typeof currentValue === 'string' &&
		currentValue.trim().toLowerCase() === 'unknown';
	const currentMissing = isMissingValue(currentValue) || currentIsUnknown;
	const incomingMissing = isMissingValue(incomingValue);
	const incomingUndefined = incomingValue === undefined;

	switch (policy) {
		case 'tmdb_authoritative':
			// Undefined means "no incoming update". Null is a valid authoritative value.
			return !incomingUndefined && currentValue !== incomingValue;
		case 'fill_if_empty':
		case 'db_authoritative':
			return currentMissing && !incomingMissing;
		default:
			return false;
	}
}

export function sameEpisodeSummary(
	left: StoredEpisodeSummary | null | undefined,
	right: StoredEpisodeSummary | null | undefined
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.airDate === right.airDate &&
		left.seasonNumber === right.seasonNumber &&
		left.episodeNumber === right.episodeNumber
	);
}

function sameHeaderContributor(
	left: HeaderContributorInput | null | undefined,
	right: HeaderContributorInput | null | undefined
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.type === right.type &&
		left.tmdbId === right.tmdbId &&
		left.name === right.name &&
		left.role === right.role
	);
}

export function sameHeaderContributors(
	left: HeaderContributorInput[] | null | undefined,
	right: HeaderContributorInput[] | null | undefined
): boolean {
	const leftList = left ?? [];
	const rightList = right ?? [];
	if (leftList.length !== rightList.length) return false;
	for (let index = 0; index < leftList.length; index += 1) {
		if (!sameHeaderContributor(leftList[index], rightList[index])) {
			return false;
		}
	}
	return true;
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
	const hasJapaneseLanguage =
		details.originalLanguage === 'ja' ||
		details.spokenLanguages.some((language) => language.iso6391 === 'ja') ||
		(details.mediaType === 'tv' && details.languages.includes('ja'));
	const hasJapaneseOrigin =
		details.originCountry.includes('JP') ||
		details.productionCountries.some((country) => country.iso31661 === 'JP');

	const score = [hasAnimationGenre, hasJapaneseLanguage, hasJapaneseOrigin].filter(Boolean).length;
	return score >= 2;
}

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

function pickPrimaryStudio(
	companies: EnrichmentCompanyInput[],
	isAnime: boolean
): HeaderContributorInput | null {
	if (companies.length === 0) return null;

	if (isAnime) {
		const japanese = companies.find((company) => company.originCountry === 'JP');
		if (japanese) {
			return {
				type: 'company',
				tmdbId: japanese.tmdbId,
				name: japanese.name,
				role: 'studio'
			};
		}
	}

	const first = companies[0];
	if (!first) return null;
	return {
		type: 'company',
		tmdbId: first.tmdbId,
		name: first.name,
		role: 'studio'
	};
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

export function dedupeCreatorCredits(
	contributors: HeaderContributorInput[]
): HeaderContributorInput[] {
	const seen = new Set<string>();
	const unique: HeaderContributorInput[] = [];
	for (const contributor of contributors) {
		const normalizedName = contributor.name.trim();
		if (normalizedName.length === 0) continue;
		const key = `${contributor.type}:${contributor.tmdbId ?? normalizedName.toLowerCase()}:${contributor.role ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ ...contributor, name: normalizedName });
	}
	return unique;
}

export function buildCreatorCredits(
	details: NormalizedMediaDetails,
	isAnime: boolean,
	companies: EnrichmentCompanyInput[]
): HeaderContributorInput[] {
	const primaryStudio = isAnime ? pickPrimaryStudio(companies, true) : null;

	if (details.mediaType === 'movie') {
		const directors = dedupeCreatorCredits(
			details.directorList.map((director) => ({
				type: 'person' as const,
				tmdbId: director.id,
				name: director.name,
				role: 'director'
			}))
		);
		const directorFallback =
			directors.length > 0
				? directors
				: dedupeCreatorCredits(
						details.director
							.split(',')
							.map((name) => name.trim())
							.filter((name) => name.length > 0)
							.map((name) => ({
								type: 'person' as const,
								tmdbId: null,
								name,
								role: 'director'
							}))
					);

		if (isAnime && primaryStudio) {
			return dedupeCreatorCredits([primaryStudio, ...directorFallback]);
		}

		return directorFallback;
	}

	if (isAnime && primaryStudio) {
		return [primaryStudio];
	}

	const creators = dedupeCreatorCredits(
		details.creatorList.map((creator) => ({
			type: 'person' as const,
			tmdbId: creator.id,
			name: creator.name,
			role: 'creator'
		}))
	);
	if (creators.length > 0) return creators;

	return dedupeCreatorCredits(
		details.creator
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name.length > 0)
			.map((name) => ({
				type: 'person' as const,
				tmdbId: null,
				name,
				role: 'creator'
			}))
	);
}

export function cloneCreatorCredits(
	contributors: ReadonlyArray<{
		type: 'person' | 'company';
		tmdbId: number | null;
		name: string;
		role: string | null;
	}>
): HeaderContributorInput[] {
	return contributors.map((contributor) => ({
		type: contributor.type,
		tmdbId: contributor.tmdbId,
		name: contributor.name,
		role: contributor.role
	}));
}

function parseDate(dateString: string | null | undefined): Date | null {
	if (!dateString) return null;
	const parsed = new Date(dateString);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStatus(status: string | undefined): string {
	return (status ?? '').trim().toLowerCase();
}

function isEndedSeries(status: string | undefined): boolean {
	const normalized = normalizeStatus(status);
	return normalized === 'ended' || normalized === 'canceled' || normalized === 'cancelled';
}

export function computeNextRefreshAt(details: NormalizedMediaDetails, now: number): number {
	if (details.mediaType === 'movie') {
		const releaseDate = parseDate(details.releaseDate);
		if (releaseDate === null) {
			// Missing release dates are uncommon but possible; keep modest cadence.
			return now + WEEK_MS;
		}

		const releaseTime = releaseDate.getTime();
		const inThirtyDays = now + 30 * DAY_MS;
		const thirtyDaysAgo = now - 30 * DAY_MS;

		if (releaseTime > inThirtyDays) {
			return now + WEEK_MS;
		}
		if (releaseTime >= thirtyDaysAgo) {
			return now + DAY_MS;
		}
		return now + 30 * DAY_MS;
	}

	if (isEndedSeries(details.status)) {
		return now + 30 * DAY_MS;
	}

	const nextAiring = parseDate(details.nextEpisodeToAir?.airDate ?? null);
	if (nextAiring !== null) {
		const delta = nextAiring.getTime() - now;
		if (delta <= 7 * DAY_MS) {
			return now + DAY_MS;
		}
		return now + WEEK_MS;
	}

	return now + WEEK_MS;
}

export function toStoredEpisodeSummary(
	episode: { airDate: string | null; seasonNumber: number; episodeNumber: number } | null
): StoredEpisodeSummary | null {
	if (!episode) return null;
	if (episode.seasonNumber <= 0 || episode.episodeNumber <= 0) return null;
	return {
		airDate: episode.airDate,
		seasonNumber: episode.seasonNumber,
		episodeNumber: episode.episodeNumber
	};
}

function evaluateStoredDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
	},
	now: number,
	hasTypeSpecificMissing: boolean,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hardMissing =
		(stored.detailSchemaVersion ?? 0) < detailSchemaVersion ||
		stored.detailFetchedAt === null ||
		stored.detailFetchedAt === undefined ||
		stored.overview === undefined ||
		stored.status === null ||
		stored.status === undefined ||
		hasTypeSpecificMissing;

	if (hardMissing) {
		return { needsRefresh: true, hardStale: true, reason: 'hard-stale' };
	}

	if ((stored.nextRefreshAt ?? 0) <= now) {
		return { needsRefresh: true, hardStale: false, reason: 'soft-stale' };
	}

	return { needsRefresh: false, hardStale: false, reason: 'fresh' };
}

export function evaluateStoredMovieDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		runtime?: number | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing =
		stored.runtime === undefined || stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing, detailSchemaVersion);
}

export function evaluateStoredTVDecision(
	stored: {
		detailSchemaVersion?: number | null;
		detailFetchedAt?: number | null;
		nextRefreshAt?: number | null;
		overview?: string | null;
		status?: string | null;
		numberOfSeasons?: number | null;
		lastAirDate?: string | null;
		creatorCredits?: HeaderContributorInput[] | null;
	},
	now: number,
	detailSchemaVersion: number
): DetailRefreshDecision {
	const hasTypeSpecificMissing =
		stored.numberOfSeasons === null ||
		stored.numberOfSeasons === undefined ||
		stored.lastAirDate === undefined ||
		stored.creatorCredits === undefined;
	return evaluateStoredDecision(stored, now, hasTypeSpecificMissing, detailSchemaVersion);
}

export function buildHeaderContext(
	credits: HeaderContributorInput[] | null | undefined,
	isAnime: boolean,
	defaultHeading: 'Directed by' | 'Created by'
): {
	heading: string;
	isAnime: boolean;
	contributors: HeaderContributorInput[];
} {
	const contributors = dedupeCreatorCredits(credits ?? []);
	const hasCompanyContributor = contributors.some((contributor) => contributor.type === 'company');
	return {
		heading: isAnime && hasCompanyContributor ? 'Animated by' : defaultHeading,
		isAnime,
		contributors
	};
}
