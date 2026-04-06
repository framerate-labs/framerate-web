import type { Doc } from '../../_generated/dataModel';
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

function normalizeSeasonKey(seasonKey: string | null | undefined): string | null {
	const trimmed = seasonKey?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

type CreditCacheDoc = Doc<'creditCache'>;

async function getCreditCacheRow(
	ctx: QueryCtx | MutationCtx,
	args: {
		mediaType: MediaType;
		tmdbId: number;
		source: CreditSource;
		seasonKey: string | null;
	}
): Promise<CreditCacheDoc | null> {
	return await ctx.db
		.query('creditCache')
		.withIndex('by_mediaType_tmdbId_source_seasonKey', (q) =>
			q
				.eq('mediaType', args.mediaType)
				.eq('tmdbId', args.tmdbId)
				.eq('source', args.source)
				.eq('seasonKey', args.seasonKey)
		)
		.unique();
}

export async function getCreditCacheBySourceHandler(
	ctx: QueryCtx,
	args: { mediaType: MediaType; tmdbId: number; source: CreditSource; seasonKey?: string | null }
): Promise<CreditCacheSnapshot | null> {
	const normalizedSeasonKey = normalizeSeasonKey(args.seasonKey);
	const row = await getCreditCacheRow(ctx, {
		mediaType: args.mediaType,
		tmdbId: args.tmdbId,
		source: args.source,
		seasonKey: normalizedSeasonKey
	});
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
	const normalizedSeasonKey = normalizeSeasonKey(args.seasonKey);
	const existing = await getCreditCacheRow(ctx, {
		mediaType: args.mediaType,
		tmdbId: args.tmdbId,
		source: args.source,
		seasonKey: normalizedSeasonKey
	});

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
}
