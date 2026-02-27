import type {
	AnimeStudioStatus,
	DetailRefreshDecision,
	EnrichmentCompanyInput,
	HeaderContributorInput,
	HeaderContributorSource,
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
		left.role === right.role &&
		(left.source ?? 'tmdb') === (right.source ?? 'tmdb') &&
		(left.sourceId ?? null) === (right.sourceId ?? null) &&
		(left.matchMethod ?? null) === (right.matchMethod ?? null) &&
		(left.matchConfidence ?? null) === (right.matchConfidence ?? null)
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
	const hasJapaneseOriginalLanguage = details.originalLanguage === 'ja';
	const hasJapaneseOrigin = details.originCountry.includes('JP');

	// Strict anime classification:
	// 1) animation genre, 2) original language is Japanese, 3) Japanese origin/production
	// We intentionally ignore spoken/dub languages to avoid false positives on western animation.
	return hasAnimationGenre && hasJapaneseOriginalLanguage && hasJapaneseOrigin;
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
		const source = contributor.source ?? 'tmdb';
		const sourceId = contributor.sourceId ?? null;
		const key = `${source}:${contributor.type}:${sourceId ?? 'none'}:${contributor.tmdbId ?? normalizedName.toLowerCase()}:${contributor.role ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({ ...contributor, source, sourceId, name: normalizedName });
	}
	return unique;
}

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
			// Preserve the full manual object for this source identity so sync refreshes
			// don't overwrite operator-curated studio rows.
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
	const studioCandidates = isAnime ? pickStudioCandidates(companies, true, 3) : [];

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
							.filter((name) => name.length > 0)
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
			.filter((name) => name.length > 0)
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

function parseDate(dateString: string | null | undefined): Date | null {
	if (!dateString) return null;
	const parsed = new Date(dateString);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stableJitterMs(seed: number, windowMs: number): number {
	// Deterministic per-title jitter to spread refreshes without random drift.
	const s = Math.max(1, Math.floor(Math.abs(seed)));
	const hash = (s * 1103515245 + 12345) & 0x7fffffff;
	return windowMs <= 0 ? 0 : hash % windowMs;
}

function withPositiveJitter(now: number, ttlMs: number, seed: number): number {
	const boundedTtl = Math.max(MINUTE_MS, ttlMs);
	const jitterWindow = Math.min(12 * HOUR_MS, Math.floor(boundedTtl * 0.1));
	return now + boundedTtl + stableJitterMs(seed, jitterWindow);
}

function normalizeStatus(status: string | undefined): string {
	return (status ?? '').trim().toLowerCase();
}

function isEndedSeries(status: string | undefined): boolean {
	const normalized = normalizeStatus(status);
	return normalized === 'ended' || normalized === 'canceled' || normalized === 'cancelled';
}

export function computeNextRefreshAt(details: NormalizedMediaDetails, now: number): number {
	const seed = details.id;
	if (details.mediaType === 'movie') {
		const releaseDate = parseDate(details.releaseDate);
		if (releaseDate === null) {
			// Missing release dates are uncommon but possible; keep modest cadence.
			return withPositiveJitter(now, WEEK_MS, seed);
		}

		const releaseTime = releaseDate.getTime();
		const inThirtyDays = now + 30 * DAY_MS;
		const thirtyDaysAgo = now - 30 * DAY_MS;
		const inSevenDays = now + 7 * DAY_MS;
		const threeDaysAgo = now - 3 * DAY_MS;

		// Most volatile window: immediately before release and just after release.
		if (
			(releaseTime >= now && releaseTime <= inSevenDays) ||
			(releaseTime < now && releaseTime >= threeDaysAgo)
		) {
			return withPositiveJitter(now, 12 * HOUR_MS, seed);
		}
		if (releaseTime > inThirtyDays) {
			return withPositiveJitter(now, WEEK_MS, seed);
		}
		if (releaseTime >= thirtyDaysAgo) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}

	const normalizedStatus = normalizeStatus(details.status);
	const statusSuggestsReturning =
		normalizedStatus.includes('returning') ||
		normalizedStatus.includes('planned') ||
		normalizedStatus.includes('production');
	const nextAiring = parseDate(details.nextEpisodeToAir?.airDate ?? null);
	if (nextAiring !== null) {
		const delta = nextAiring.getTime() - now;
		if (delta <= 7 * DAY_MS) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		if (delta <= 30 * DAY_MS) {
			return withPositiveJitter(now, 3 * DAY_MS, seed);
		}
		if (delta <= 120 * DAY_MS) {
			return withPositiveJitter(now, 14 * DAY_MS, seed);
		}
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}

	const lastEpisodeAired = parseDate(details.lastEpisodeToAir?.airDate ?? null);
	if (lastEpisodeAired !== null) {
		const sinceLastEpisode = now - lastEpisodeAired.getTime();
		if (sinceLastEpisode <= 3 * DAY_MS) {
			return withPositiveJitter(now, DAY_MS, seed);
		}
		if (sinceLastEpisode <= 30 * DAY_MS) {
			return withPositiveJitter(now, 3 * DAY_MS, seed);
		}
		if (sinceLastEpisode <= 90 * DAY_MS) {
			return withPositiveJitter(now, 14 * DAY_MS, seed);
		}
		if (details.inProduction || statusSuggestsReturning) {
			if (sinceLastEpisode <= 180 * DAY_MS) {
				return withPositiveJitter(now, 30 * DAY_MS, seed);
			}
			return withPositiveJitter(now, 45 * DAY_MS, seed);
		}
	}

	const lastAir = parseDate(details.lastAirDate);
	if (isEndedSeries(details.status) && lastAir !== null) {
		const sinceLastAir = now - lastAir.getTime();
		if (sinceLastAir <= 60 * DAY_MS) {
			return withPositiveJitter(now, 30 * DAY_MS, seed);
		}
		if (sinceLastAir <= 365 * DAY_MS) {
			return withPositiveJitter(now, 90 * DAY_MS, seed);
		}
		return withPositiveJitter(now, 180 * DAY_MS, seed);
	}

	if (isEndedSeries(details.status)) {
		return withPositiveJitter(now, 90 * DAY_MS, seed);
	}

	if (details.inProduction || statusSuggestsReturning) {
		return withPositiveJitter(now, 30 * DAY_MS, seed);
	}
	return withPositiveJitter(now, 45 * DAY_MS, seed);
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

function selectAniListStudioCredits(credits: HeaderContributorInput[]): HeaderContributorInput[] {
	const studios = credits.filter((credit) => credit.role === 'studio' && credit.type === 'company');
	if (studios.length === 0) return [];
	const anilistStudios = studios.filter((credit) => (credit.source ?? 'tmdb') === 'anilist');
	return anilistStudios;
}

function selectManualStudioCredits(credits: HeaderContributorInput[]): HeaderContributorInput[] {
	const studios = credits.filter((credit) => credit.role === 'studio' && credit.type === 'company');
	if (studios.length === 0) return [];
	return studios.filter((credit) => (credit.matchMethod ?? null) === 'manual');
}

function selectAnyStudioCredits(credits: HeaderContributorInput[]): HeaderContributorInput[] {
	return credits.filter((credit) => credit.role === 'studio' && credit.type === 'company');
}

function selectSingleFallbackStudioCredit(
	credits: HeaderContributorInput[]
): HeaderContributorInput[] {
	const studios = selectAnyStudioCredits(credits);
	return studios.length > 0 ? [studios[0]] : [];
}

export function hasAniListStudioCredits(
	credits: HeaderContributorInput[] | null | undefined
): boolean {
	if (!credits || credits.length === 0) return false;
	return credits.some(
		(credit) =>
			credit.type === 'company' &&
			credit.role === 'studio' &&
			(credit.source ?? 'tmdb') === 'anilist'
	);
}

export function hasManualStudioCredits(
	credits: HeaderContributorInput[] | null | undefined
): boolean {
	if (!credits || credits.length === 0) return false;
	return credits.some(
		(credit) =>
			credit.type === 'company' &&
			credit.role === 'studio' &&
			(credit.matchMethod ?? null) === 'manual'
	);
}

function selectHeaderDisplayContributors(
	credits: HeaderContributorInput[],
	isAnime: boolean,
	mediaType: MediaType,
	animeStudioStatus: AnimeStudioStatus
): HeaderContributorInput[] {
	const deduped = dedupeCreatorCredits(credits);

	if (mediaType === 'tv') {
		if (isAnime) {
			const manualStudios = selectManualStudioCredits(deduped);
			if (manualStudios.length > 0) return manualStudios;
			if (animeStudioStatus === 'resolved') return selectAniListStudioCredits(deduped);
			if (animeStudioStatus === 'unavailable') return selectSingleFallbackStudioCredit(deduped);
			return [];
		}
		const creators = deduped.filter(
			(credit) => credit.role === 'creator' && credit.type === 'person'
		);
		return creators.length > 0 ? creators : deduped;
	}

	if (isAnime) {
		const manualStudios = selectManualStudioCredits(deduped);
		if (manualStudios.length > 0) {
			const directors = deduped.filter(
				(credit) => credit.role === 'director' && credit.type === 'person'
			);
			const combined = dedupeCreatorCredits([...manualStudios, ...directors]);
			return combined.length > 0 ? combined : directors;
		}
		const studios =
			animeStudioStatus === 'resolved'
				? selectAniListStudioCredits(deduped)
				: animeStudioStatus === 'unavailable'
					? selectSingleFallbackStudioCredit(deduped)
					: [];
		const directors = deduped.filter(
			(credit) => credit.role === 'director' && credit.type === 'person'
		);
		const combined = dedupeCreatorCredits([...studios, ...directors]);
		return combined.length > 0 ? combined : directors;
	}

	const directors = deduped.filter(
		(credit) => credit.role === 'director' && credit.type === 'person'
	);
	return directors.length > 0 ? directors : deduped;
}

export function buildHeaderContext(
	credits: HeaderContributorInput[] | null | undefined,
	isAnime: boolean,
	mediaType: MediaType,
	animeStudioStatus: AnimeStudioStatus
): {
	isAnime: boolean;
	animeStudioStatus: AnimeStudioStatus;
	contributors: HeaderContributorInput[];
} {
	const contributors = selectHeaderDisplayContributors(
		credits ?? [],
		isAnime,
		mediaType,
		animeStudioStatus
	);
	return {
		isAnime,
		animeStudioStatus,
		contributors
	};
}
