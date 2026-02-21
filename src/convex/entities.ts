import { v } from 'convex/values';

import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalMutation, internalQuery } from './_generated/server';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const COMPANY_GRAPH_MAX_DISCOVER_PAGES = 8;
const PERSON_LINK_ROLE = 'contributor';
const PERSON_LINK_SOURCE = 'tmdb' as const;
const PERSON_LINK_CREDIT_PREFIX = 'person-link';

const worksMediaFilterValidator = v.union(v.literal('all'), v.literal('movie'), v.literal('tv'));
const personRoleFilterValidator = v.union(
	v.literal('all'),
	v.literal('actor'),
	v.literal('director'),
	v.literal('creator'),
	v.literal('writer'),
	v.literal('producer')
);
const workReferenceValidator = v.object({
	mediaType: v.union(v.literal('movie'), v.literal('tv')),
	tmdbId: v.number(),
	billingOrder: v.number()
});

type WorkMediaType = 'movie' | 'tv';

type WorkRow = {
	mediaType: WorkMediaType;
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string | null;
	role: string | null;
	billingOrder: number | null;
};

type AnnotatedWork = {
	mediaType: WorkMediaType;
	tmdbId: number;
	title: string;
	posterPath: string | null;
	releaseDate: string | null;
	role: string | null;
	inLibrary: boolean;
	watched: boolean;
};

type PersonMediaReference = {
	mediaType: WorkMediaType;
	tmdbId: number;
	billingOrder: number;
};

type WorkLibraryState = {
	mediaType: WorkMediaType;
	tmdbId: number;
	inLibrary: boolean;
	watched: boolean;
};

type TMDBPersonCredit = {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	department?: string | null;
	job?: string | null;
	credit_id?: string;
	order?: number;
	title?: string;
	name?: string;
	poster_path?: string | null;
	release_date?: string | null;
	first_air_date?: string | null;
};

type TMDBPersonDetailsResponse = {
	id: number;
	name: string;
	profile_path: string | null;
	biography?: string | null;
	combined_credits?: {
		cast?: TMDBPersonCredit[];
		crew?: TMDBPersonCredit[];
	};
};

type TMDBCompanyDetailsResponse = {
	id: number;
	name: string;
	logo_path: string | null;
	description?: string | null;
};

type TMDBDiscoverResponse = {
	page?: number;
	total_pages?: number;
	results?: Array<{
		id?: number;
		title?: string;
		name?: string;
		poster_path?: string | null;
		release_date?: string | null;
		first_air_date?: string | null;
	}>;
};

function parseDateToEpoch(dateString: string | null): number {
	if (!dateString) return 0;
	const parsed = Date.parse(dateString);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortWorksByDateThenTitle(a: WorkRow, b: WorkRow): number {
	const aTime = parseDateToEpoch(a.releaseDate);
	const bTime = parseDateToEpoch(b.releaseDate);
	if (aTime !== bTime) return bTime - aTime;
	return a.title.localeCompare(b.title);
}

function dedupeWorks(rows: WorkRow[]): WorkRow[] {
	const map = new Map<string, WorkRow>();
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

function mediaReferenceKey(mediaType: WorkMediaType, tmdbId: number): string {
	return `${mediaType}:${tmdbId}`;
}

function personLinkCreditId(personTmdbId: number, mediaType: WorkMediaType, mediaTmdbId: number): string {
	return `${PERSON_LINK_CREDIT_PREFIX}:${personTmdbId}:${mediaType}:${mediaTmdbId}`;
}

function parsePersonLinkMediaTmdbId(
	creditId: string,
	personTmdbId: number,
	mediaType: WorkMediaType
): number | null {
	const parts = creditId.split(':');
	if (parts.length !== 4) return null;
	const [prefix, personIdPart, mediaTypePart, mediaTmdbIdPart] = parts;
	if (prefix !== PERSON_LINK_CREDIT_PREFIX) return null;
	if (personIdPart !== String(personTmdbId)) return null;
	if (mediaTypePart !== mediaType) return null;
	const mediaTmdbId = Number(mediaTmdbIdPart);
	return Number.isFinite(mediaTmdbId) ? mediaTmdbId : null;
}

function dedupePersonMediaReferences(references: PersonMediaReference[]): PersonMediaReference[] {
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

function buildPersonMediaReferences(payload: TMDBPersonDetailsResponse): PersonMediaReference[] {
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

function annotateWorksWithLibraryState(works: WorkRow[], states: WorkLibraryState[]): AnnotatedWork[] {
	const stateByMedia = new Map<string, WorkLibraryState>();
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

function applyWorksFilters(
	works: AnnotatedWork[],
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
): WorkRow | null {
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
			credit.media_type === 'movie'
				? (credit.release_date ?? null)
				: (credit.first_air_date ?? null),
		role,
		billingOrder
	};
}

function buildPersonWorksFromTMDB(
	payload: TMDBPersonDetailsResponse,
	options: {
		mediaFilter: 'all' | 'movie' | 'tv';
		roleFilter: 'all' | 'actor' | 'director' | 'creator' | 'writer' | 'producer';
	}
): { works: WorkRow[]; movieCreditCount: number; tvCreditCount: number; roles: string[] } {
	const rows: WorkRow[] = [];
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

		const row = mapPersonCreditToWork(
			credit,
			'actor',
			typeof credit.order === 'number' ? credit.order : index
		);
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

	const deduped = dedupeWorks(rows).sort(sortWorksByDateThenTitle);
	return {
		works: deduped,
		movieCreditCount,
		tvCreditCount,
		roles: Array.from(rolesDiscovered.values()).sort()
	};
}

async function fetchPersonFromTMDB(tmdbPersonId: number): Promise<TMDBPersonDetailsResponse> {
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const response = await fetch(
		`${TMDB_API_BASE}/person/${tmdbPersonId}?append_to_response=combined_credits&language=en-US`,
		{
			method: 'GET',
			headers: {
				accept: 'application/json',
				Authorization: `Bearer ${apiToken}`
			}
		}
	);

	if (!response.ok) {
		let message = `TMDB API Error: ${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { status_message?: string; status_code?: number };
			if (body.status_message) {
				message = `TMDB API Error: ${body.status_code ?? response.status} – ${body.status_message}`;
			}
		} catch {
			// Keep fallback message.
		}
		throw new Error(message);
	}

	const payload = (await response.json()) as TMDBPersonDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB person API');
	}

	return payload;
}

function parseTMDBErrorPayload(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const statusMessage = (value as { status_message?: unknown }).status_message;
	const statusCode = (value as { status_code?: unknown }).status_code;
	if (typeof statusMessage !== 'string' || statusMessage.trim() === '') return null;
	return `TMDB API Error: ${typeof statusCode === 'number' ? statusCode : 'unknown'} – ${statusMessage}`;
}

function parseTMDBDiscoverResponse(
	value: unknown
): {
	items: Array<{
		id: number;
		title: string | null;
		posterPath: string | null;
		releaseDate: string | null;
	}>;
	totalPages: number;
} {
	if (!value || typeof value !== 'object') {
		throw new Error('Invalid response structure from TMDB discover API');
	}

	const payload = value as TMDBDiscoverResponse;
	const results = Array.isArray(payload.results) ? payload.results : [];
	const items = results
		.map((result) => {
			if (!result || typeof result.id !== 'number') return null;
			const titleCandidate =
				typeof result.title === 'string'
					? result.title
					: typeof result.name === 'string'
						? result.name
						: null;
			return {
				id: result.id,
				title: titleCandidate?.trim() ? titleCandidate.trim() : null,
				posterPath: typeof result.poster_path === 'string' ? result.poster_path : null,
				releaseDate:
					typeof result.release_date === 'string'
						? result.release_date
						: typeof result.first_air_date === 'string'
							? result.first_air_date
							: null
			};
		})
		.filter(
			(item): item is { id: number; title: string | null; posterPath: string | null; releaseDate: string | null } =>
				item !== null
		);
	const totalPages =
		typeof payload.total_pages === 'number' && payload.total_pages > 0
			? Math.floor(payload.total_pages)
			: 1;

	return { items, totalPages };
}

async function fetchCompanyWorksFromTMDB(
	tmdbCompanyId: number,
	mediaType: WorkMediaType,
	maxPages: number = COMPANY_GRAPH_MAX_DISCOVER_PAGES
): Promise<WorkRow[]> {
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
	const rows: WorkRow[] = [];
	let page = 1;
	let totalPages = 1;
	const safeMaxPages = Math.max(1, maxPages);

	while (page <= totalPages && page <= safeMaxPages) {
		const url = `${TMDB_API_BASE}/discover/${endpoint}?language=en-US&with_companies=${tmdbCompanyId}&sort_by=popularity.desc&page=${page}`;
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				Authorization: `Bearer ${apiToken}`
			}
		});

		if (!response.ok) {
			let message = `TMDB API Error: ${response.status} ${response.statusText}`;
			try {
				const parsed = parseTMDBErrorPayload(await response.json());
				if (parsed) {
					message = parsed;
				}
			} catch {
				// Keep fallback message.
			}
			throw new Error(message);
		}

		const parsed = parseTMDBDiscoverResponse(await response.json());
		totalPages = Math.min(safeMaxPages, parsed.totalPages);
		for (let index = 0; index < parsed.items.length; index += 1) {
			const item = parsed.items[index];
			if (!item || !item.title) continue;
			rows.push({
				mediaType,
				tmdbId: item.id,
				title: item.title,
				posterPath: item.posterPath,
				releaseDate: item.releaseDate,
				role: 'production',
				billingOrder: (page - 1) * 100 + index
			});
		}
		page += 1;
	}

	return dedupeWorks(rows).sort(sortWorksByDateThenTitle);
}

async function fetchCompanyFromTMDB(tmdbCompanyId: number): Promise<TMDBCompanyDetailsResponse> {
	const apiToken = process.env.TMDB_API_TOKEN;
	if (!apiToken) {
		throw new Error('Server misconfiguration: missing TMDB_API_TOKEN');
	}

	const response = await fetch(`${TMDB_API_BASE}/company/${tmdbCompanyId}`, {
		method: 'GET',
		headers: {
			accept: 'application/json',
			Authorization: `Bearer ${apiToken}`
		}
	});

	if (!response.ok) {
		let message = `TMDB API Error: ${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as { status_message?: string; status_code?: number };
			if (body.status_message) {
				message = `TMDB API Error: ${body.status_code ?? response.status} – ${body.status_message}`;
			}
		} catch {
			// Keep fallback message.
		}
		throw new Error(message);
	}

	const payload = (await response.json()) as TMDBCompanyDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB company API');
	}
	return payload;
}

export const resolveWorksLibraryState = internalQuery({
	args: {
		userId: v.union(v.string(), v.null()),
		personTmdbId: v.optional(v.number()),
		works: v.array(workReferenceValidator)
	},
	handler: async (ctx, args): Promise<WorkLibraryState[]> => {
		const dedupedReferences = dedupePersonMediaReferences(args.works as PersonMediaReference[]);
		const states: WorkLibraryState[] = [];
		const userId = args.userId;
		const personTmdbId = args.personTmdbId ?? null;

		const linkedMovieIdByTmdbId = new Map<number, Id<'movies'>>();
		const linkedTVIdByTmdbId = new Map<number, Id<'tvShows'>>();
		const movieTmdbIdsToCheck = new Set<number>();
		const tvTmdbIdsToCheck = new Set<number>();

		for (const reference of dedupedReferences) {
			if (reference.mediaType === 'movie') {
				movieTmdbIdsToCheck.add(reference.tmdbId);
			} else {
				tvTmdbIdsToCheck.add(reference.tmdbId);
			}
		}

		if (personTmdbId !== null) {
			const movieCredits = await ctx.db
				.query('movieCredits')
				.withIndex('by_personTmdbId_role', (q) => q.eq('personTmdbId', personTmdbId).eq('role', PERSON_LINK_ROLE))
				.collect();
			for (const credit of movieCredits) {
				if (credit.source !== PERSON_LINK_SOURCE) continue;
				const mediaTmdbId = parsePersonLinkMediaTmdbId(credit.creditId, personTmdbId, 'movie');
				if (mediaTmdbId === null) continue;
				if (!movieTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedMovieIdByTmdbId.set(mediaTmdbId, credit.movieId);
			}

			const tvCredits = await ctx.db
				.query('tvCredits')
				.withIndex('by_personTmdbId_role', (q) => q.eq('personTmdbId', personTmdbId).eq('role', PERSON_LINK_ROLE))
				.collect();
			for (const credit of tvCredits) {
				if (credit.source !== PERSON_LINK_SOURCE) continue;
				const mediaTmdbId = parsePersonLinkMediaTmdbId(credit.creditId, personTmdbId, 'tv');
				if (mediaTmdbId === null) continue;
				if (!tvTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedTVIdByTmdbId.set(mediaTmdbId, credit.tvShowId);
			}
		} else {
			// Fallback path when link context is not available (e.g. company page).
			for (const movieTmdbId of movieTmdbIdsToCheck) {
				const movie = await ctx.db
					.query('movies')
					.withIndex('by_tmdbId', (q) => q.eq('tmdbId', movieTmdbId))
					.unique();
				if (!movie) continue;
				linkedMovieIdByTmdbId.set(movieTmdbId, movie._id);
			}
			for (const tvTmdbId of tvTmdbIdsToCheck) {
				const tvShow = await ctx.db
					.query('tvShows')
					.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tvTmdbId))
					.unique();
				if (!tvShow) continue;
				linkedTVIdByTmdbId.set(tvTmdbId, tvShow._id);
			}
		}

		const watchedMovies = new Set<number>();
		const watchedTV = new Set<number>();
		if (userId) {
			for (const movieTmdbId of movieTmdbIdsToCheck) {
				const movieId = linkedMovieIdByTmdbId.get(movieTmdbId);
				if (!movieId) continue;
				const review = await ctx.db
					.query('movieReviews')
					.withIndex('by_userId_movieId', (q) => q.eq('userId', userId).eq('movieId', movieId))
					.unique();
				if (review?.watched) watchedMovies.add(movieTmdbId);
			}

			for (const tvTmdbId of tvTmdbIdsToCheck) {
				const tvShowId = linkedTVIdByTmdbId.get(tvTmdbId);
				if (!tvShowId) continue;
				const review = await ctx.db
					.query('tvReviews')
					.withIndex('by_userId_tvShowId', (q) => q.eq('userId', userId).eq('tvShowId', tvShowId))
					.unique();
				if (review?.watched) watchedTV.add(tvTmdbId);
			}
		}

		for (const reference of dedupedReferences) {
			if (reference.mediaType === 'movie') {
				const inLibrary = linkedMovieIdByTmdbId.has(reference.tmdbId);
				states.push({
					mediaType: 'movie',
					tmdbId: reference.tmdbId,
					inLibrary,
					watched: inLibrary ? watchedMovies.has(reference.tmdbId) : false
				});
				continue;
			}

			const inLibrary = linkedTVIdByTmdbId.has(reference.tmdbId);
			states.push({
				mediaType: 'tv',
				tmdbId: reference.tmdbId,
				inLibrary,
				watched: inLibrary ? watchedTV.has(reference.tmdbId) : false
			});
		}

		return states;
	}
});

export const syncPersonFromTMDB = internalMutation({
	args: {
		tmdbPersonId: v.number(),
		name: v.string(),
		profilePath: v.union(v.string(), v.null()),
		references: v.array(workReferenceValidator)
	},
	handler: async (ctx, args) => {
		const dedupedReferences = dedupePersonMediaReferences(args.references as PersonMediaReference[]);

		const existingPerson = await ctx.db
			.query('people')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbPersonId))
			.unique();

		let personId: Id<'people'>;
		if (!existingPerson) {
			personId = await ctx.db.insert('people', {
				tmdbId: args.tmdbPersonId,
				name: args.name,
				profilePath: args.profilePath
			});
		} else {
			personId = existingPerson._id;
			const patch: { name?: string; profilePath?: string | null } = {};
			if (existingPerson.name !== args.name) {
				patch.name = args.name;
			}
			if (existingPerson.profilePath !== args.profilePath) {
				patch.profilePath = args.profilePath;
			}
			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(existingPerson._id, patch);
			}
		}

		const existingMovieCredits = await ctx.db
			.query('movieCredits')
			.withIndex('by_personTmdbId_role', (q) =>
				q.eq('personTmdbId', args.tmdbPersonId).eq('role', PERSON_LINK_ROLE)
			)
			.collect();
		const existingTVCredits = await ctx.db
			.query('tvCredits')
			.withIndex('by_personTmdbId_role', (q) =>
				q.eq('personTmdbId', args.tmdbPersonId).eq('role', PERSON_LINK_ROLE)
			)
			.collect();

		const existingMovieByCreditId = new Map(existingMovieCredits.map((credit) => [credit.creditId, credit]));
		const existingTVByCreditId = new Map(existingTVCredits.map((credit) => [credit.creditId, credit]));
		const desiredMovieCreditIds = new Set<string>();
		const desiredTVCreditIds = new Set<string>();

		for (const reference of dedupedReferences) {
			if (reference.mediaType === 'movie') {
				const movie = await ctx.db
					.query('movies')
					.withIndex('by_tmdbId', (q) => q.eq('tmdbId', reference.tmdbId))
					.unique();
				if (!movie) continue;

				const creditId = personLinkCreditId(args.tmdbPersonId, 'movie', reference.tmdbId);
				desiredMovieCreditIds.add(creditId);
				const existingCredit = existingMovieByCreditId.get(creditId);

				if (!existingCredit) {
					await ctx.db.insert('movieCredits', {
						movieId: movie._id,
						personId,
						personTmdbId: args.tmdbPersonId,
						role: PERSON_LINK_ROLE,
						creditId,
						billingOrder: reference.billingOrder,
						source: PERSON_LINK_SOURCE
					});
					continue;
				}

			const patch: {
				movieId?: Id<'movies'>;
				personId?: Id<'people'>;
					personTmdbId?: number;
					role?: string;
					billingOrder?: number;
					source?: 'tmdb';
				} = {};

				if (existingCredit.movieId !== movie._id) patch.movieId = movie._id;
				if (existingCredit.personId !== personId) patch.personId = personId;
				if (existingCredit.personTmdbId !== args.tmdbPersonId) patch.personTmdbId = args.tmdbPersonId;
				if (existingCredit.role !== PERSON_LINK_ROLE) patch.role = PERSON_LINK_ROLE;
				if (existingCredit.billingOrder !== reference.billingOrder) patch.billingOrder = reference.billingOrder;
				if (existingCredit.source !== PERSON_LINK_SOURCE) patch.source = PERSON_LINK_SOURCE;

				if (Object.keys(patch).length > 0) {
					await ctx.db.patch(existingCredit._id, patch);
				}
				continue;
			}

			const tvShow = await ctx.db
				.query('tvShows')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', reference.tmdbId))
				.unique();
			if (!tvShow) continue;

			const creditId = personLinkCreditId(args.tmdbPersonId, 'tv', reference.tmdbId);
			desiredTVCreditIds.add(creditId);
			const existingCredit = existingTVByCreditId.get(creditId);

			if (!existingCredit) {
				await ctx.db.insert('tvCredits', {
					tvShowId: tvShow._id,
					personId,
					personTmdbId: args.tmdbPersonId,
					role: PERSON_LINK_ROLE,
					creditId,
					billingOrder: reference.billingOrder,
					source: PERSON_LINK_SOURCE
				});
				continue;
			}

			const patch: {
				tvShowId?: Id<'tvShows'>;
				personId?: Id<'people'>;
				personTmdbId?: number;
				role?: string;
				billingOrder?: number;
				source?: 'tmdb';
			} = {};

			if (existingCredit.tvShowId !== tvShow._id) patch.tvShowId = tvShow._id;
			if (existingCredit.personId !== personId) patch.personId = personId;
			if (existingCredit.personTmdbId !== args.tmdbPersonId) patch.personTmdbId = args.tmdbPersonId;
			if (existingCredit.role !== PERSON_LINK_ROLE) patch.role = PERSON_LINK_ROLE;
			if (existingCredit.billingOrder !== reference.billingOrder) patch.billingOrder = reference.billingOrder;
			if (existingCredit.source !== PERSON_LINK_SOURCE) patch.source = PERSON_LINK_SOURCE;

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(existingCredit._id, patch);
			}
		}

		for (const existingCredit of existingMovieCredits) {
			const isManaged =
				existingCredit.source === PERSON_LINK_SOURCE &&
				existingCredit.role === PERSON_LINK_ROLE &&
				existingCredit.creditId.startsWith(`${PERSON_LINK_CREDIT_PREFIX}:`);
			if (!isManaged) continue;
			if (!desiredMovieCreditIds.has(existingCredit.creditId)) {
				await ctx.db.delete(existingCredit._id);
			}
		}

		for (const existingCredit of existingTVCredits) {
			const isManaged =
				existingCredit.source === PERSON_LINK_SOURCE &&
				existingCredit.role === PERSON_LINK_ROLE &&
				existingCredit.creditId.startsWith(`${PERSON_LINK_CREDIT_PREFIX}:`);
			if (!isManaged) continue;
			if (!desiredTVCreditIds.has(existingCredit.creditId)) {
				await ctx.db.delete(existingCredit._id);
			}
		}
	}
});

export const getPersonPageFromTMDB = action({
	args: {
		tmdbPersonId: v.number(),
		mediaFilter: v.optional(worksMediaFilterValidator),
		role: v.optional(personRoleFilterValidator),
		inLibraryOnly: v.optional(v.boolean()),
		unwatchedOnly: v.optional(v.boolean()),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const mediaFilter = (args.mediaFilter ?? 'all') as 'all' | 'movie' | 'tv';
		const roleFilter = (args.role ?? 'all') as
			| 'all'
			| 'actor'
			| 'director'
			| 'creator'
			| 'writer'
			| 'producer';
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = Math.max(1, Math.min(args.limit ?? 100, 250));
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;

		const payload = await fetchPersonFromTMDB(args.tmdbPersonId);
		const personMediaReferences = buildPersonMediaReferences(payload);
		await ctx.runMutation(internal.entities.syncPersonFromTMDB, {
			tmdbPersonId: payload.id,
			name: payload.name,
			profilePath: payload.profile_path,
			references: personMediaReferences
		});
		const summaryData = buildPersonWorksFromTMDB(payload, {
			mediaFilter: 'all',
			roleFilter: 'all'
		});
		const worksData = buildPersonWorksFromTMDB(payload, {
			mediaFilter,
			roleFilter
		});

		const libraryStates = await ctx.runQuery(internal.entities.resolveWorksLibraryState, {
			userId,
			personTmdbId: payload.id,
			works: worksData.works.map((work, index) => ({
				mediaType: work.mediaType,
				tmdbId: work.tmdbId,
				billingOrder: work.billingOrder ?? index
			}))
		});
		const annotated = annotateWorksWithLibraryState(worksData.works, libraryStates as WorkLibraryState[]);
		const filtered = applyWorksFilters(annotated, {
			mediaFilter: 'all',
			inLibraryOnly,
			unwatchedOnly
		});

		return {
			summary: {
				tmdbId: payload.id,
				name: payload.name,
				profilePath: payload.profile_path,
				bio: payload.biography ?? null,
				movieCreditCount: summaryData.movieCreditCount,
				tvCreditCount: summaryData.tvCreditCount,
				roles: summaryData.roles
			},
			works: filtered.slice(0, safeLimit)
		};
	}
});

export const getCompanyPageFromTMDB = action({
	args: {
		tmdbCompanyId: v.number(),
		mediaFilter: v.optional(worksMediaFilterValidator),
		inLibraryOnly: v.optional(v.boolean()),
		unwatchedOnly: v.optional(v.boolean()),
		limit: v.optional(v.number())
	},
	handler: async (ctx, args) => {
		const mediaFilter = (args.mediaFilter ?? 'all') as 'all' | 'movie' | 'tv';
		const inLibraryOnly = args.inLibraryOnly ?? false;
		const unwatchedOnly = args.unwatchedOnly ?? false;
		const safeLimit = Math.max(1, Math.min(args.limit ?? 100, 250));
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;

		const [payload, movieWorks, tvWorks] = await Promise.all([
			fetchCompanyFromTMDB(args.tmdbCompanyId),
			fetchCompanyWorksFromTMDB(args.tmdbCompanyId, 'movie'),
			fetchCompanyWorksFromTMDB(args.tmdbCompanyId, 'tv')
		]);

		const roles = movieWorks.length > 0 || tvWorks.length > 0 ? ['production'] : [];
		const deduped = dedupeWorks([...movieWorks, ...tvWorks]).sort(sortWorksByDateThenTitle);
		const libraryStates = await ctx.runQuery(internal.entities.resolveWorksLibraryState, {
			userId,
			works: deduped.map((work, index) => ({
				mediaType: work.mediaType,
				tmdbId: work.tmdbId,
				billingOrder: work.billingOrder ?? index
			}))
		});
		const annotated = annotateWorksWithLibraryState(deduped, libraryStates as WorkLibraryState[]);
		const filtered = applyWorksFilters(annotated, {
			mediaFilter,
			inLibraryOnly,
			unwatchedOnly
		});

		return {
			summary: {
				tmdbId: payload.id,
				name: payload.name,
				logoPath: payload.logo_path,
				bio: payload.description ?? null,
				movieCount: movieWorks.length,
				tvCount: tvWorks.length,
				roles
			},
			works: filtered.slice(0, safeLimit)
		};
	}
});
