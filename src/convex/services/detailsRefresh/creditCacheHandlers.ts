import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { CreditCacheSnapshot, CreditCoverage, CreditSource } from '../../types/detailsType';
import type { MediaType } from '../../types/mediaTypes';
import type { StoredCastCredit, StoredCrewCredit } from '../../types/detailsType';

import { coverageRank } from '../../utils/details/credits';

type UpsertCreditCacheArgs = {
	mediaType: MediaType;
	tmdbId: number;
	source: CreditSource;
	seasonKey: string | null;
	coverage: CreditCoverage;
	castCredits: StoredCastCredit[];
	crewCredits: StoredCrewCredit[];
	castTotal: number;
	crewTotal: number;
	fetchedAt: number;
	nextRefreshAt: number;
};

function pickLatestByFetchedAt<T extends { fetchedAt: number; _creationTime: number }>(
	rows: T[]
): T | null {
	if (rows.length === 0) return null;
	let latest = rows[0] ?? null;
	for (const row of rows) {
		if (latest == null) {
			latest = row;
			continue;
		}
		if (row.fetchedAt > latest.fetchedAt) {
			latest = row;
			continue;
		}
		if (row.fetchedAt === latest.fetchedAt && row._creationTime > latest._creationTime) {
			latest = row;
		}
	}
	return latest;
}

export async function getCreditCacheBySourceHandler(
	ctx: QueryCtx,
	args: { mediaType: MediaType; tmdbId: number; source: CreditSource; seasonKey?: string | null }
): Promise<CreditCacheSnapshot | null> {
	const normalizedSeasonKey = args.seasonKey ?? null;
	const rows = await ctx.db
		.query('creditCache')
		.withIndex('by_mediaType_tmdbId_source_seasonKey', (q) =>
			q
				.eq('mediaType', args.mediaType)
				.eq('tmdbId', args.tmdbId)
				.eq('source', args.source)
				.eq('seasonKey', normalizedSeasonKey)
		)
		.collect();
	const row = pickLatestByFetchedAt(rows);
	if (!row) return null;
	return {
		mediaType: row.mediaType,
		tmdbId: row.tmdbId,
		source: row.source,
		seasonKey: row.seasonKey ?? null,
		coverage: row.coverage,
		castCredits: row.castCredits,
		crewCredits: row.crewCredits,
		castTotal: row.castTotal,
		crewTotal: row.crewTotal,
		fetchedAt: row.fetchedAt,
		nextRefreshAt: row.nextRefreshAt
	};
}

export async function upsertCreditCacheHandler(ctx: MutationCtx, args: UpsertCreditCacheArgs) {
	const normalizedSeasonKey = args.seasonKey ?? null;
	const rows = await ctx.db
		.query('creditCache')
		.withIndex('by_mediaType_tmdbId_source_seasonKey', (q) =>
			q
				.eq('mediaType', args.mediaType)
				.eq('tmdbId', args.tmdbId)
				.eq('source', args.source)
				.eq('seasonKey', normalizedSeasonKey)
		)
		.collect();
	const existing = pickLatestByFetchedAt(rows);

	if (!existing) {
		await ctx.db.insert('creditCache', {
			mediaType: args.mediaType,
			tmdbId: args.tmdbId,
			source: args.source,
			seasonKey: normalizedSeasonKey,
			coverage: args.coverage,
			castCredits: args.castCredits,
			crewCredits: args.crewCredits,
			castTotal: args.castTotal,
			crewTotal: args.crewTotal,
			fetchedAt: args.fetchedAt,
			nextRefreshAt: args.nextRefreshAt
		});
		return;
	}

	const existingRank = coverageRank(existing.coverage);
	const incomingRank = coverageRank(args.coverage);
	if (existingRank > incomingRank) {
		// Keep existing full snapshots authoritative over incoming preview writes.
		for (const row of rows) {
			if (row._id === existing._id) continue;
			await ctx.db.delete(row._id);
		}
		return;
	}

	await ctx.db.patch(existing._id, {
		coverage: args.coverage,
		castCredits: args.castCredits,
		crewCredits: args.crewCredits,
		castTotal: args.castTotal,
		crewTotal: args.crewTotal,
		fetchedAt: args.fetchedAt,
		nextRefreshAt: args.nextRefreshAt
	});
	for (const row of rows) {
		if (row._id === existing._id) continue;
		await ctx.db.delete(row._id);
	}
}

export async function upsertStoredMediaCreditsHandler(
	ctx: MutationCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		castCredits: StoredCastCredit[];
		crewCredits: StoredCrewCredit[];
	}
) {
	if (args.mediaType === 'movie') {
		const row = await ctx.db
			.query('movies')
			.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
			.unique();
		if (!row) return;
		await ctx.db.patch(row._id, {
			castCredits: args.castCredits,
			crewCredits: args.crewCredits
		});
		return;
	}

	const row = await ctx.db
		.query('tvShows')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', args.tmdbId))
		.unique();
	if (!row) return;
	await ctx.db.patch(row._id, {
		castCredits: args.castCredits,
		crewCredits: args.crewCredits
	});
}
