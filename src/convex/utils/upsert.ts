export async function upsertByExisting<TExisting>({
	findExisting,
	onInsert,
	onUpdate
}: {
	findExisting: () => Promise<TExisting | null>;
	onInsert: () => Promise<void>;
	onUpdate: (existing: TExisting) => Promise<void>;
}): Promise<void> {
	const existing = await findExisting();
	if (existing) {
		await onUpdate(existing);
		return;
	}
	await onInsert();
}
