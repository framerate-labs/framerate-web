import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type {
	DesiredMovieLink,
	DesiredTVLink,
	ManagedLinkRowId,
	PersonMediaReference,
	ResolvedMovieReference,
	ResolvedTVReference
} from '../types/entitiesTypes';

export async function resolveExistingMediaReferences(
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

export function toDesiredMovieLinks(references: ResolvedMovieReference[]): DesiredMovieLink[] {
	return references.map((reference) => ({
		mediaTmdbId: reference.tmdbId,
		movieId: reference.movieId,
		billingOrder: reference.billingOrder
	}));
}

export function toDesiredTVLinks(references: ResolvedTVReference[]): DesiredTVLink[] {
	return references.map((reference) => ({
		mediaTmdbId: reference.tmdbId,
		tvShowId: reference.tvShowId,
		billingOrder: reference.billingOrder
	}));
}

async function syncManagedLinks<
	TExistingRow extends { _id: ManagedLinkRowId },
	TDesiredRow
>(params: {
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

export async function syncManagedMovieLinks<
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

export async function syncManagedTVLinks<
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

export async function upsertPersonRecord(
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

export async function upsertCompanyRecord(
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
