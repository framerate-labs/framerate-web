import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

function pickCanonicalOverrideRow<T extends Doc<'movieOverrides'> | Doc<'tvOverrides'>>(
	rows: T[]
): T | null {
	let best: T | null = null;
	let bestUpdatedAt = Number.NEGATIVE_INFINITY;
	let bestCreatedAt = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const updatedAt = row.updatedAt ?? 0;
		const createdAt = row._creationTime ?? 0;
		if (
			best === null ||
			updatedAt > bestUpdatedAt ||
			(updatedAt === bestUpdatedAt && createdAt > bestCreatedAt)
		) {
			best = row;
			bestUpdatedAt = updatedAt;
			bestCreatedAt = createdAt;
		}
	}
	return best;
}

export async function getCanonicalMovieOverrideAndCleanup(
	ctx: MutationCtx,
	tmdbId: number
): Promise<Doc<'movieOverrides'> | null> {
	const rows = await ctx.db
		.query('movieOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	const canonical = pickCanonicalOverrideRow(rows);
	for (const row of rows) {
		if (canonical && row._id === canonical._id) continue;
		await ctx.db.delete(row._id);
	}
	return canonical;
}

export async function getCanonicalTVOverrideAndCleanup(
	ctx: MutationCtx,
	tmdbId: number
): Promise<Doc<'tvOverrides'> | null> {
	const rows = await ctx.db
		.query('tvOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	const canonical = pickCanonicalOverrideRow(rows);
	for (const row of rows) {
		if (canonical && row._id === canonical._id) continue;
		await ctx.db.delete(row._id);
	}
	return canonical;
}

export async function clearMovieOverridesByTMDBId(
	ctx: MutationCtx,
	tmdbId: number
): Promise<number> {
	const rows = await ctx.db
		.query('movieOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	for (const row of rows) await ctx.db.delete(row._id);
	return rows.length;
}

export async function clearTVOverridesByTMDBId(ctx: MutationCtx, tmdbId: number): Promise<number> {
	const rows = await ctx.db
		.query('tvOverrides')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', tmdbId))
		.collect();
	for (const row of rows) await ctx.db.delete(row._id);
	return rows.length;
}
