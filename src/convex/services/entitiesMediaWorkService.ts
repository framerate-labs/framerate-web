import type {
	AnnotatedMediaWork,
	PersonMediaReference,
	TMDBPersonCredit,
	TMDBPersonDetailsResponse,
	MediaLibraryState,
	MediaWorkType,
	MediaWork
} from '../types/entitiesTypes';

function parseDateToEpoch(dateString: string | null): number {
	if (!dateString) return 0;
	const parsed = Date.parse(dateString);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortMediaWorksByDateThenTitle(a: MediaWork, b: MediaWork): number {
	const aTime = parseDateToEpoch(a.releaseDate);
	const bTime = parseDateToEpoch(b.releaseDate);
	if (aTime !== bTime) return bTime - aTime;
	return a.title.localeCompare(b.title);
}

export function dedupeMediaWorks(rows: MediaWork[]): MediaWork[] {
	const map = new Map<string, MediaWork>();
	for (const row of rows) {
		// Keep separate entries per role. If one title has multiple roles (e.g. director + producer),
		// it should appear in each role bucket.
		const key = `${row.mediaType}:${row.tmdbId}:${row.role ?? 'unknown'}`;
		const existing = map.get(key);
		if (!existing) {
			map.set(key, row);
			continue;
		}

		const existingOrder = existing.billingOrder ?? Number.MAX_SAFE_INTEGER;
		const incomingOrder = row.billingOrder ?? Number.MAX_SAFE_INTEGER;
		if (incomingOrder < existingOrder) {
			map.set(key, row);
		}
	}
	return Array.from(map.values());
}

export function mediaReferenceKey(mediaType: MediaWorkType, tmdbId: number): string {
	return `${mediaType}:${tmdbId}`;
}

export function dedupePersonMediaReferences(references: PersonMediaReference[]): PersonMediaReference[] {
	const deduped = new Map<string, PersonMediaReference>();
	for (const reference of references) {
		const key = mediaReferenceKey(reference.mediaType, reference.tmdbId);
		const existing = deduped.get(key);
		if (!existing || reference.billingOrder < existing.billingOrder) {
			deduped.set(key, reference);
		}
	}
	return Array.from(deduped.values());
}

export function toMediaReferences(works: MediaWork[]): PersonMediaReference[] {
	return works.map((work, index) => ({
		mediaType: work.mediaType,
		tmdbId: work.tmdbId,
		billingOrder: work.billingOrder ?? index
	}));
}

export function clampMediaWorkLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(limit ?? 100, 250));
}

export function annotateMediaWorksWithLibraryState(works: MediaWork[], states: MediaLibraryState[]): AnnotatedMediaWork[] {
	const stateByMedia = new Map<string, MediaLibraryState>();
	for (const state of states) {
		stateByMedia.set(mediaReferenceKey(state.mediaType, state.tmdbId), state);
	}

	return works.map((work) => {
		const state = stateByMedia.get(mediaReferenceKey(work.mediaType, work.tmdbId));
		return {
			mediaType: work.mediaType,
			tmdbId: work.tmdbId,
			title: work.title,
			posterPath: work.posterPath,
			releaseDate: work.releaseDate,
			role: work.role,
			inLibrary: state?.inLibrary ?? false,
			watched: state?.watched ?? false
		};
	});
}

export function applyMediaWorkFilters(
	works: AnnotatedMediaWork[],
	options: {
		mediaFilter: 'all' | 'movie' | 'tv';
		inLibraryOnly: boolean;
		unwatchedOnly: boolean;
	}
) {
	let filtered = works;
	if (options.mediaFilter !== 'all') {
		filtered = filtered.filter((work) => work.mediaType === options.mediaFilter);
	}
	if (options.inLibraryOnly) {
		filtered = filtered.filter((work) => work.inLibrary);
	}
	if (options.unwatchedOnly) {
		filtered = filtered.filter((work) => !work.watched);
	}
	return filtered;
}

function normalizeLower(value: string | null | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

function mapCrewRole(job: string | null | undefined, department: string | null | undefined): string | null {
	const normalizedJob = normalizeLower(job);
	const normalizedDepartment = normalizeLower(department);

	if (normalizedJob === 'director' || normalizedDepartment === 'directing') {
		return 'director';
	}
	if (
		normalizedJob.includes('writer') ||
		normalizedJob === 'screenplay' ||
		normalizedJob === 'story' ||
		normalizedJob === 'teleplay' ||
		normalizedJob === 'novel' ||
		normalizedDepartment === 'writing'
	) {
		return 'writer';
	}
	if (normalizedJob.includes('producer') || normalizedDepartment === 'production') {
		return 'producer';
	}
	if (normalizedJob === 'creator') {
		return 'creator';
	}
	return null;
}

function mapPersonCreditToWork(
	credit: TMDBPersonCredit,
	role: string,
	billingOrder: number
): MediaWork | null {
	if (credit.media_type !== 'movie' && credit.media_type !== 'tv') return null;
	if (typeof credit.id !== 'number') return null;

	const title = (credit.media_type === 'movie' ? credit.title : credit.name)?.trim() ?? '';
	if (title.length === 0) return null;

	return {
		mediaType: credit.media_type,
		tmdbId: credit.id,
		title,
		posterPath: typeof credit.poster_path === 'string' ? credit.poster_path : null,
		releaseDate:
			credit.media_type === 'movie' ? (credit.release_date ?? null) : (credit.first_air_date ?? null),
		role,
		billingOrder
	};
}

export function buildPersonMediaWorksFromTMDB(
	payload: TMDBPersonDetailsResponse,
	options: {
		mediaFilter: 'all' | 'movie' | 'tv';
		roleFilter: 'all' | 'actor' | 'director' | 'creator' | 'writer' | 'producer';
	}
): { works: MediaWork[]; movieCreditCount: number; tvCreditCount: number; roles: string[] } {
	const rows: MediaWork[] = [];
	const rolesDiscovered = new Set<string>();
	let movieCreditCount = 0;
	let tvCreditCount = 0;

	const castCredits = payload.combined_credits?.cast ?? [];
	for (let index = 0; index < castCredits.length; index += 1) {
		const credit = castCredits[index];
		if (!credit || typeof credit.id !== 'number') continue;
		if (credit.media_type !== 'movie' && credit.media_type !== 'tv') continue;
		if (options.roleFilter !== 'all' && options.roleFilter !== 'actor') continue;

		if (credit.media_type === 'movie') movieCreditCount += 1;
		if (credit.media_type === 'tv') tvCreditCount += 1;
		rolesDiscovered.add('actor');

		const row = mapPersonCreditToWork(credit, 'actor', typeof credit.order === 'number' ? credit.order : index);
		if (!row) continue;
		if (options.mediaFilter !== 'all' && row.mediaType !== options.mediaFilter) continue;
		rows.push(row);
	}

	const crewCredits = payload.combined_credits?.crew ?? [];
	for (let index = 0; index < crewCredits.length; index += 1) {
		const credit = crewCredits[index];
		if (!credit || typeof credit.id !== 'number') continue;
		if (credit.media_type !== 'movie' && credit.media_type !== 'tv') continue;
		const role = mapCrewRole(credit.job, credit.department);
		if (!role) continue;
		if (options.roleFilter !== 'all' && options.roleFilter !== role) continue;

		if (credit.media_type === 'movie') movieCreditCount += 1;
		if (credit.media_type === 'tv') tvCreditCount += 1;
		rolesDiscovered.add(role);

		const row = mapPersonCreditToWork(credit, role, index);
		if (!row) continue;
		if (options.mediaFilter !== 'all' && row.mediaType !== options.mediaFilter) continue;
		rows.push(row);
	}

	const deduped = dedupeMediaWorks(rows).sort(sortMediaWorksByDateThenTitle);
	return {
		works: deduped,
		movieCreditCount,
		tvCreditCount,
		roles: Array.from(rolesDiscovered.values()).sort()
	};
}

export function buildPersonMediaReferences(payload: TMDBPersonDetailsResponse): PersonMediaReference[] {
	const references: PersonMediaReference[] = [];

	const castCredits = payload.combined_credits?.cast ?? [];
	for (let index = 0; index < castCredits.length; index += 1) {
		const credit = castCredits[index];
		if (!credit || typeof credit.id !== 'number') continue;
		if (credit.media_type !== 'movie' && credit.media_type !== 'tv') continue;
		references.push({
			mediaType: credit.media_type,
			tmdbId: credit.id,
			billingOrder: typeof credit.order === 'number' ? credit.order : index
		});
	}

	const crewCredits = payload.combined_credits?.crew ?? [];
	for (let index = 0; index < crewCredits.length; index += 1) {
		const credit = crewCredits[index];
		if (!credit || typeof credit.id !== 'number') continue;
		if (credit.media_type !== 'movie' && credit.media_type !== 'tv') continue;
		references.push({
			mediaType: credit.media_type,
			tmdbId: credit.id,
			billingOrder: index
		});
	}

	return dedupePersonMediaReferences(references);
}
