import type {
	CollectionDoc,
	CollectionItemDoc,
	CollectionSortDirection,
	CollectionTierDoc
} from '../../types/collectionTypes';

function normalizeSortableReleaseDate(value: string | null | undefined) {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

export function resolvedCollectionSortDirection(
	collection: Pick<CollectionDoc, 'defaultSortDirection'>
): CollectionSortDirection {
	return collection.defaultSortDirection ?? 'descending';
}

export function sortItemsForCollectionPreview(
	items: CollectionItemDoc[],
	collection: CollectionDoc,
	tiers: CollectionTierDoc[]
) {
	if (collection.layout === 'tiered') {
		const tierRank = new Map(tiers.map((tier, index) => [tier.key, index] as const));
		return [...items].sort((left, right) => {
			if (left.tierKey !== right.tierKey) {
				if (left.tierKey == null) return -1;
				if (right.tierKey == null) return 1;
				return (
					(tierRank.get(left.tierKey) ?? Number.MAX_SAFE_INTEGER) -
					(tierRank.get(right.tierKey) ?? Number.MAX_SAFE_INTEGER)
				);
			}
			return left.sortOrder - right.sortOrder;
		});
	}

	const customOrderItems = [...items].sort((left, right) => left.sortOrder - right.sortOrder);
	if (collection.layout === 'ordered' || collection.defaultSort === 'custom') {
		return customOrderItems;
	}

	const direction = resolvedCollectionSortDirection(collection);
	const multiplier = direction === 'ascending' ? 1 : -1;

	switch (collection.defaultSort) {
		case 'title':
			return customOrderItems.sort((left, right) => {
				const comparison = left.title.localeCompare(right.title, undefined, {
					sensitivity: 'base'
				});
				if (comparison !== 0) return comparison * multiplier;
				return left.sortOrder - right.sortOrder;
			});
		case 'releaseDate':
			return customOrderItems.sort((left, right) => {
				const leftDate = normalizeSortableReleaseDate(left.releaseDate);
				const rightDate = normalizeSortableReleaseDate(right.releaseDate);
				if (leftDate === rightDate) {
					const comparison = left.title.localeCompare(right.title, undefined, {
						sensitivity: 'base'
					});
					if (comparison !== 0) return comparison;
					return left.sortOrder - right.sortOrder;
				}
				if (leftDate == null) return direction === 'ascending' ? -1 : 1;
				if (rightDate == null) return direction === 'ascending' ? 1 : -1;
				return direction === 'ascending'
					? leftDate.localeCompare(rightDate)
					: rightDate.localeCompare(leftDate);
			});
		case 'dateAdded':
			return customOrderItems.sort((left, right) => {
				if (left.createdAt === right.createdAt) {
					return left.sortOrder - right.sortOrder;
				}
				return direction === 'ascending'
					? left.createdAt - right.createdAt
					: right.createdAt - left.createdAt;
			});
	}
}

export function sortItemsForPresentation(
	items: CollectionItemDoc[],
	layout: CollectionDoc['layout'],
	tiers: CollectionTierDoc[]
) {
	const presentItem = (item: CollectionItemDoc) => ({
		id: item._id,
		mediaType: item.mediaType,
		tmdbId: item.tmdbId,
		title: item.title,
		posterPath: item.posterPath,
		releaseDate: item.releaseDate,
		isAnime: item.isAnime,
		tierKey: item.tierKey,
		sortOrder: item.sortOrder,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt
	});

	if (layout !== 'tiered') {
		return {
			items: items.sort((left, right) => left.sortOrder - right.sortOrder).map(presentItem),
			tiers: []
		};
	}

	const grouped = new Map<string, CollectionItemDoc[]>();
	for (const item of items) {
		const key = item.tierKey ?? '';
		const bucket = grouped.get(key) ?? [];
		bucket.push(item);
		grouped.set(key, bucket);
	}
	return {
		items: [],
		tiers: tiers.map((tier) => ({
			key: tier.key,
			label: tier.label,
			sortOrder: tier.sortOrder,
			items: (grouped.get(tier.key) ?? [])
				.sort((left, right) => left.sortOrder - right.sortOrder)
				.map(presentItem)
		}))
	};
}
