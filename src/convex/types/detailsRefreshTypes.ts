export type DetailRefreshConfig = {
	detailSchemaVersion: number;
	leaseTtlMs: number;
	pruneLimit: number;
	scanPerType: number;
	maxRefreshes: number;
	batchSize: number;
	expediteRecheckMs: number;
};
