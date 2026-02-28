import type { AnimeStudioStatus, HeaderContributorInput } from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';

import { dedupeCreatorCredits } from './creatorCredits';

function selectAniListStudioCredits(credits: HeaderContributorInput[]): HeaderContributorInput[] {
	const studios = credits.filter((credit) => credit.role === 'studio' && credit.type === 'company');
	if (studios.length === 0) return [];
	return studios.filter((credit) => (credit.source ?? 'tmdb') === 'anilist');
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
