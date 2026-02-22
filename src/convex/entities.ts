import { v } from 'convex/values';

import type { ActionCtx, MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { action, internalMutation, internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type {
	AnnotatedWork,
	DesiredMovieLink,
	DesiredTVLink,
	ManagedLinkRowId,
	PersonMediaReference,
	ResolvedMovieReference,
	ResolvedTVReference,
	TMDBCompanyDetailsResponse,
	TMDBDiscoverResponse,
	TMDBPersonCredit,
	TMDBPersonDetailsResponse,
	WorkLibraryState,
	WorkMediaType,
	WorkRow,
	WorksQueryContext
} from './types/entitiesTypes';
import { fetchTMDBJson } from './utils/tmdb';

const COMPANY_GRAPH_MAX_DISCOVER_PAGES = 8;
const PERSON_LINK_SOURCE = 'tmdb' as const;
const COMPANY_LINK_SOURCE = 'tmdb' as const;

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

async function resolveExistingMediaReferences(
	ctx: MutationCtx,
	references: PersonMediaReference[]
): Promise<{ movies: ResolvedMovieReference[]; tvShows: ResolvedTVReference[] }> {
	const movies: ResolvedMovieReference[] = [];
	const tvShows: ResolvedTVReference[] = [];

	for (const reference of references) {
		if (reference.mediaType === 'movie') {
			const movie = await ctx.db
				.query('movies')
				.withIndex('by_tmdbId', (q) => q.eq('tmdbId', reference.tmdbId))
				.unique();
			if (!movie) continue;
			movies.push({
				tmdbId: reference.tmdbId,
				billingOrder: reference.billingOrder,
				movieId: movie._id
			});
			continue;
		}

		const tvShow = await ctx.db
			.query('tvShows')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', reference.tmdbId))
			.unique();
		if (!tvShow) continue;
		tvShows.push({
			tmdbId: reference.tmdbId,
			billingOrder: reference.billingOrder,
			tvShowId: tvShow._id
		});
	}

	return { movies, tvShows };
}

function toDesiredMovieLinks(
	references: ResolvedMovieReference[]
): DesiredMovieLink[] {
	return references.map((reference) => ({
		mediaTmdbId: reference.tmdbId,
		movieId: reference.movieId,
		billingOrder: reference.billingOrder
	}));
}

function toDesiredTVLinks(
	references: ResolvedTVReference[]
): DesiredTVLink[] {
	return references.map((reference) => ({
		mediaTmdbId: reference.tmdbId,
		tvShowId: reference.tvShowId,
		billingOrder: reference.billingOrder
	}));
}

function toWorkReferences(works: WorkRow[]): PersonMediaReference[] {
	return works.map((work, index) => ({
		mediaType: work.mediaType,
		tmdbId: work.tmdbId,
		billingOrder: work.billingOrder ?? index
	}));
}

function clampWorksLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(limit ?? 100, 250));
}

async function syncManagedLinks<TExistingRow extends { _id: ManagedLinkRowId }, TDesiredRow>(params: {
	ctx: MutationCtx;
	existingRows: TExistingRow[];
	desiredRows: TDesiredRow[];
	getExistingKey: (row: TExistingRow) => string;
	getDesiredKey: (row: TDesiredRow) => string;
	isManagedRow: (row: TExistingRow) => boolean;
	insertDesiredRow: (row: TDesiredRow) => Promise<void>;
	patchExistingRow: (existing: TExistingRow, desired: TDesiredRow) => Promise<void>;
}): Promise<void> {
	const managedByKey = new Map<string, TExistingRow>();
	const duplicateIds: ManagedLinkRowId[] = [];

	for (const existing of params.existingRows) {
		if (!params.isManagedRow(existing)) continue;
		const key = params.getExistingKey(existing);
		if (managedByKey.has(key)) {
			duplicateIds.push(existing._id);
			continue;
		}
		managedByKey.set(key, existing);
	}

	const desiredKeys = new Set<string>();
	for (const desired of params.desiredRows) {
		const key = params.getDesiredKey(desired);
		desiredKeys.add(key);
		const existing = managedByKey.get(key);
		if (!existing) {
			await params.insertDesiredRow(desired);
			continue;
		}
		await params.patchExistingRow(existing, desired);
	}

	for (const [key, existing] of managedByKey) {
		if (desiredKeys.has(key)) continue;
		await params.ctx.db.delete(existing._id);
	}

	for (const duplicateId of duplicateIds) {
		await params.ctx.db.delete(duplicateId);
	}
}

async function syncManagedMovieLinks<
	TExisting extends {
		_id: ManagedLinkRowId;
		movieId: Id<'movies'>;
		mediaTmdbId: number;
		billingOrder: number;
		source: 'tmdb';
	}
>(params: {
	ctx: MutationCtx;
	existingRows: TExisting[];
	desiredRows: DesiredMovieLink[];
	isManagedRow: (row: TExisting) => boolean;
	insertDesiredRow: (row: DesiredMovieLink) => Promise<void>;
	buildEntityPatch: (existing: TExisting) => {
		personId?: Id<'people'>;
		personTmdbId?: number;
		companyId?: Id<'companies'>;
		companyTmdbId?: number;
	};
}): Promise<void> {
	await syncManagedLinks({
		ctx: params.ctx,
		existingRows: params.existingRows,
		desiredRows: params.desiredRows,
		getExistingKey: (row) => String(row.mediaTmdbId),
		getDesiredKey: (row) => String(row.mediaTmdbId),
		isManagedRow: params.isManagedRow,
		insertDesiredRow: params.insertDesiredRow,
		patchExistingRow: async (existing, desired) => {
			const patch: {
				movieId?: Id<'movies'>;
				mediaTmdbId?: number;
				billingOrder?: number;
				source?: 'tmdb';
				personId?: Id<'people'>;
				personTmdbId?: number;
				companyId?: Id<'companies'>;
				companyTmdbId?: number;
			} = params.buildEntityPatch(existing);

			if (existing.movieId !== desired.movieId) patch.movieId = desired.movieId;
			if (existing.mediaTmdbId !== desired.mediaTmdbId) patch.mediaTmdbId = desired.mediaTmdbId;
			if (existing.billingOrder !== desired.billingOrder) patch.billingOrder = desired.billingOrder;
			if (existing.source !== 'tmdb') patch.source = 'tmdb';

			if (Object.keys(patch).length > 0) {
				await params.ctx.db.patch(existing._id, patch);
			}
		}
	});
}

async function syncManagedTVLinks<
	TExisting extends {
		_id: ManagedLinkRowId;
		tvShowId: Id<'tvShows'>;
		mediaTmdbId: number;
		billingOrder: number;
		source: 'tmdb';
	}
>(params: {
	ctx: MutationCtx;
	existingRows: TExisting[];
	desiredRows: DesiredTVLink[];
	isManagedRow: (row: TExisting) => boolean;
	insertDesiredRow: (row: DesiredTVLink) => Promise<void>;
	buildEntityPatch: (existing: TExisting) => {
		personId?: Id<'people'>;
		personTmdbId?: number;
		companyId?: Id<'companies'>;
		companyTmdbId?: number;
	};
}): Promise<void> {
	await syncManagedLinks({
		ctx: params.ctx,
		existingRows: params.existingRows,
		desiredRows: params.desiredRows,
		getExistingKey: (row) => String(row.mediaTmdbId),
		getDesiredKey: (row) => String(row.mediaTmdbId),
		isManagedRow: params.isManagedRow,
		insertDesiredRow: params.insertDesiredRow,
		patchExistingRow: async (existing, desired) => {
			const patch: {
				tvShowId?: Id<'tvShows'>;
				mediaTmdbId?: number;
				billingOrder?: number;
				source?: 'tmdb';
				personId?: Id<'people'>;
				personTmdbId?: number;
				companyId?: Id<'companies'>;
				companyTmdbId?: number;
			} = params.buildEntityPatch(existing);

			if (existing.tvShowId !== desired.tvShowId) patch.tvShowId = desired.tvShowId;
			if (existing.mediaTmdbId !== desired.mediaTmdbId) patch.mediaTmdbId = desired.mediaTmdbId;
			if (existing.billingOrder !== desired.billingOrder) patch.billingOrder = desired.billingOrder;
			if (existing.source !== 'tmdb') patch.source = 'tmdb';

			if (Object.keys(patch).length > 0) {
				await params.ctx.db.patch(existing._id, patch);
			}
		}
	});
}

async function upsertPersonRecord(
	ctx: MutationCtx,
	input: { tmdbId: number; name: string; profilePath: string | null }
): Promise<Id<'people'>> {
	const existing = await ctx.db
		.query('people')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', input.tmdbId))
		.unique();

	if (!existing) {
		return await ctx.db.insert('people', {
			tmdbId: input.tmdbId,
			name: input.name,
			profilePath: input.profilePath
		});
	}

	const patch: { name?: string; profilePath?: string | null } = {};
	if (existing.name !== input.name) patch.name = input.name;
	if (existing.profilePath !== input.profilePath) patch.profilePath = input.profilePath;
	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}
	return existing._id;
}

async function upsertCompanyRecord(
	ctx: MutationCtx,
	input: { tmdbId: number; name: string; logoPath: string | null }
): Promise<Id<'companies'>> {
	const existing = await ctx.db
		.query('companies')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', input.tmdbId))
		.unique();

	if (!existing) {
		return await ctx.db.insert('companies', {
			tmdbId: input.tmdbId,
			name: input.name,
			logoPath: input.logoPath
		});
	}

	const patch: { name?: string; logoPath?: string | null } = {};
	if (existing.name !== input.name) patch.name = input.name;
	if (existing.logoPath !== input.logoPath) patch.logoPath = input.logoPath;
	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}
	return existing._id;
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

async function annotateAndFilterWorks(
	ctx: ActionCtx,
	params: {
		userId: string | null;
		works: WorkRow[];
		mediaFilter: 'all' | 'movie' | 'tv';
		inLibraryOnly: boolean;
		unwatchedOnly: boolean;
		queryContext: WorksQueryContext;
	}
): Promise<AnnotatedWork[]> {
	const references = toWorkReferences(params.works);
	const libraryStates = (await ctx.runQuery(internal.entities.resolveWorksLibraryState, {
		userId: params.userId,
		...params.queryContext,
		works: references
	})) as WorkLibraryState[];
	const annotated = annotateWorksWithLibraryState(params.works, libraryStates);
	return applyWorksFilters(annotated, {
		mediaFilter: params.mediaFilter,
		inLibraryOnly: params.inLibraryOnly,
		unwatchedOnly: params.unwatchedOnly
	});
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
	const payload = (await fetchTMDBJson(`/person/${tmdbPersonId}`, {
		params: {
			append_to_response: 'combined_credits',
			language: 'en-US'
		}
	})) as TMDBPersonDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB person API');
	}

	return payload;
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
	const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
	const rows: WorkRow[] = [];
	let page = 1;
	let totalPages = 1;
	const safeMaxPages = Math.max(1, maxPages);

	while (page <= totalPages && page <= safeMaxPages) {
		const parsed = parseTMDBDiscoverResponse(
			await fetchTMDBJson(`/discover/${endpoint}`, {
				params: {
					language: 'en-US',
					with_companies: tmdbCompanyId,
					sort_by: 'popularity.desc',
					page
				}
			})
		);
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
	const payload = (await fetchTMDBJson(`/company/${tmdbCompanyId}`)) as TMDBCompanyDetailsResponse;
	if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
		throw new Error('Invalid response structure from TMDB company API');
	}
	return payload;
}

export const resolveWorksLibraryState = internalQuery({
	args: {
		userId: v.union(v.string(), v.null()),
		personTmdbId: v.optional(v.number()),
		companyTmdbId: v.optional(v.number()),
		works: v.array(workReferenceValidator)
	},
	handler: async (ctx, args): Promise<WorkLibraryState[]> => {
		const dedupedReferences = dedupePersonMediaReferences(args.works as PersonMediaReference[]);
		const states: WorkLibraryState[] = [];
		const userId = args.userId;
		const personTmdbId = args.personTmdbId ?? null;
		const companyTmdbId = args.companyTmdbId ?? null;

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
				.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', personTmdbId))
				.collect();
			for (const credit of movieCredits) {
				if (credit.source !== PERSON_LINK_SOURCE) continue;
				const mediaTmdbId =
					typeof credit.mediaTmdbId === 'number'
						? credit.mediaTmdbId
						: (await ctx.db.get(credit.movieId))?.tmdbId;
				if (typeof mediaTmdbId !== 'number') continue;
				if (!movieTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedMovieIdByTmdbId.set(mediaTmdbId, credit.movieId);
			}

			const tvCredits = await ctx.db
				.query('tvCredits')
				.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', personTmdbId))
				.collect();
			for (const credit of tvCredits) {
				if (credit.source !== PERSON_LINK_SOURCE) continue;
				const mediaTmdbId =
					typeof credit.mediaTmdbId === 'number'
						? credit.mediaTmdbId
						: (await ctx.db.get(credit.tvShowId))?.tmdbId;
				if (typeof mediaTmdbId !== 'number') continue;
				if (!tvTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedTVIdByTmdbId.set(mediaTmdbId, credit.tvShowId);
			}
		} else if (companyTmdbId !== null) {
			const movieCompanyLinks = await ctx.db
				.query('movieCompanies')
				.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', companyTmdbId))
				.collect();
			for (const link of movieCompanyLinks) {
				if (link.source !== COMPANY_LINK_SOURCE) continue;
				const mediaTmdbId =
					typeof link.mediaTmdbId === 'number'
						? link.mediaTmdbId
						: (await ctx.db.get(link.movieId))?.tmdbId;
				if (typeof mediaTmdbId !== 'number') continue;
				if (!movieTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedMovieIdByTmdbId.set(mediaTmdbId, link.movieId);
			}

			const tvCompanyLinks = await ctx.db
				.query('tvCompanies')
				.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', companyTmdbId))
				.collect();
			for (const link of tvCompanyLinks) {
				if (link.source !== COMPANY_LINK_SOURCE) continue;
				const mediaTmdbId =
					typeof link.mediaTmdbId === 'number'
						? link.mediaTmdbId
						: (await ctx.db.get(link.tvShowId))?.tmdbId;
				if (typeof mediaTmdbId !== 'number') continue;
				if (!tvTmdbIdsToCheck.has(mediaTmdbId)) continue;
				linkedTVIdByTmdbId.set(mediaTmdbId, link.tvShowId);
			}
		} else {
			// Fallback path when link context is not available.
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
		const personId = await upsertPersonRecord(ctx, {
			tmdbId: args.tmdbPersonId,
			name: args.name,
			profilePath: args.profilePath
		});
		const resolvedReferences = await resolveExistingMediaReferences(ctx, dedupedReferences);
		const desiredMovieCredits = toDesiredMovieLinks(resolvedReferences.movies);
		const desiredTVCredits = toDesiredTVLinks(resolvedReferences.tvShows);

		const existingMovieCredits = await ctx.db
			.query('movieCredits')
			.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', args.tmdbPersonId))
			.collect();
		const existingTVCredits = await ctx.db
			.query('tvCredits')
			.withIndex('by_personTmdbId', (q) => q.eq('personTmdbId', args.tmdbPersonId))
			.collect();

		await syncManagedMovieLinks({
			ctx,
			existingRows: existingMovieCredits,
			desiredRows: desiredMovieCredits,
			isManagedRow: (row) => row.source === PERSON_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('movieCredits', {
					movieId: row.movieId,
					personId,
					personTmdbId: args.tmdbPersonId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: PERSON_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.personId !== personId ? { personId } : {}),
				...(existing.personTmdbId !== args.tmdbPersonId
					? { personTmdbId: args.tmdbPersonId }
					: {})
			})
		});

		await syncManagedTVLinks({
			ctx,
			existingRows: existingTVCredits,
			desiredRows: desiredTVCredits,
			isManagedRow: (row) => row.source === PERSON_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('tvCredits', {
					tvShowId: row.tvShowId,
					personId,
					personTmdbId: args.tmdbPersonId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: PERSON_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.personId !== personId ? { personId } : {}),
				...(existing.personTmdbId !== args.tmdbPersonId
					? { personTmdbId: args.tmdbPersonId }
					: {})
			})
		});
	}
});

export const syncCompanyFromTMDB = internalMutation({
	args: {
		tmdbCompanyId: v.number(),
		name: v.string(),
		logoPath: v.union(v.string(), v.null()),
		references: v.array(workReferenceValidator)
	},
	handler: async (ctx, args) => {
		const dedupedReferences = dedupePersonMediaReferences(args.references as PersonMediaReference[]);
		const companyId = await upsertCompanyRecord(ctx, {
			tmdbId: args.tmdbCompanyId,
			name: args.name,
			logoPath: args.logoPath
		});
		const resolvedReferences = await resolveExistingMediaReferences(ctx, dedupedReferences);
		const desiredMovieLinks = toDesiredMovieLinks(resolvedReferences.movies);
		const desiredTVLinks = toDesiredTVLinks(resolvedReferences.tvShows);

		const existingMovieLinks = await ctx.db
			.query('movieCompanies')
			.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', args.tmdbCompanyId))
			.collect();
		const existingTVLinks = await ctx.db
			.query('tvCompanies')
			.withIndex('by_companyTmdbId', (q) => q.eq('companyTmdbId', args.tmdbCompanyId))
			.collect();

		await syncManagedMovieLinks({
			ctx,
			existingRows: existingMovieLinks,
			desiredRows: desiredMovieLinks,
			isManagedRow: (row) => row.source === COMPANY_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('movieCompanies', {
					movieId: row.movieId,
					companyId,
					companyTmdbId: args.tmdbCompanyId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: COMPANY_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.companyId !== companyId ? { companyId } : {}),
				...(existing.companyTmdbId !== args.tmdbCompanyId
					? { companyTmdbId: args.tmdbCompanyId }
					: {})
			})
		});

		await syncManagedTVLinks({
			ctx,
			existingRows: existingTVLinks,
			desiredRows: desiredTVLinks,
			isManagedRow: (row) => row.source === COMPANY_LINK_SOURCE,
			insertDesiredRow: async (row) => {
				await ctx.db.insert('tvCompanies', {
					tvShowId: row.tvShowId,
					companyId,
					companyTmdbId: args.tmdbCompanyId,
					mediaTmdbId: row.mediaTmdbId,
					billingOrder: row.billingOrder,
					source: COMPANY_LINK_SOURCE
				});
			},
			buildEntityPatch: (existing) => ({
				...(existing.companyId !== companyId ? { companyId } : {}),
				...(existing.companyTmdbId !== args.tmdbCompanyId
					? { companyTmdbId: args.tmdbCompanyId }
					: {})
			})
		});
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
		const safeLimit = clampWorksLimit(args.limit);
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

		const filtered = await annotateAndFilterWorks(ctx, {
			userId,
			works: worksData.works,
			mediaFilter: 'all',
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				personTmdbId: payload.id
			}
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
		const safeLimit = clampWorksLimit(args.limit);
		const identity = await ctx.auth.getUserIdentity();
		const userId = identity?.subject ?? null;

		const [payload, movieWorks, tvWorks] = await Promise.all([
			fetchCompanyFromTMDB(args.tmdbCompanyId),
			fetchCompanyWorksFromTMDB(args.tmdbCompanyId, 'movie'),
			fetchCompanyWorksFromTMDB(args.tmdbCompanyId, 'tv')
		]);

		const roles = movieWorks.length > 0 || tvWorks.length > 0 ? ['production'] : [];
		const deduped = dedupeWorks([...movieWorks, ...tvWorks]).sort(sortWorksByDateThenTitle);
		await ctx.runMutation(internal.entities.syncCompanyFromTMDB, {
			tmdbCompanyId: payload.id,
			name: payload.name,
			logoPath: payload.logo_path,
			references: toWorkReferences(deduped)
		});
		const filtered = await annotateAndFilterWorks(ctx, {
			userId,
			works: deduped,
			mediaFilter,
			inLibraryOnly,
			unwatchedOnly,
			queryContext: {
				companyTmdbId: payload.id
			}
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
