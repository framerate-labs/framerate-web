import type {
	HeaderContributorInput,
	StoredEpisodeSummary,
	StoredTVSeasonSummary,
	SyncPolicy
} from '../../types/detailsType';

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

function sameTVSeasonSummary(
	left: StoredTVSeasonSummary | null | undefined,
	right: StoredTVSeasonSummary | null | undefined
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.overview === right.overview &&
		left.airDate === right.airDate &&
		left.episodeCount === right.episodeCount &&
		left.posterPath === right.posterPath &&
		left.seasonNumber === right.seasonNumber &&
		left.voteAverage === right.voteAverage
	);
}

export function sameTVSeasonSummaries(
	left: StoredTVSeasonSummary[] | null | undefined,
	right: StoredTVSeasonSummary[] | null | undefined
): boolean {
	const leftList = left ?? [];
	const rightList = right ?? [];
	if (leftList.length !== rightList.length) return false;
	for (let index = 0; index < leftList.length; index += 1) {
		if (!sameTVSeasonSummary(leftList[index], rightList[index])) {
			return false;
		}
	}
	return true;
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
