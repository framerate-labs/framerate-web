import type { CollectionDoc, Restrictions, ShareAudience } from '../../types/collectionTypes';

const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_COMMENT_LENGTH = 1000;
const MAX_TIERS = 20;
const REBALANCE_GAP_MIN = 0.000001;

export const MAX_COLLECTION_ITEMS = 200;
export const MAX_COLLABORATORS = 32;
export const MAX_VIEWER_INVITES = 256;
export const MAX_VISIBLE_COMMENTS = 100;
export const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VIEW_RETENTION_MS = 45 * VIEW_WINDOW_MS;
export const ORDER_STEP = 1024;

export function normalizeTitle(value: string): string {
	const trimmed = value.trim().replace(/\s+/g, ' ');
	if (trimmed.length === 0) throw new Error('Collection title is required.');
	if (trimmed.length > MAX_TITLE_LENGTH) {
		throw new Error(`Collection title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

export function normalizeDescription(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(
			`Collection description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`
		);
	}
	return trimmed;
}

export function normalizeCommentBody(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error('Comment cannot be empty.');
	if (trimmed.length > MAX_COMMENT_LENGTH) {
		throw new Error(`Comment must be ${MAX_COMMENT_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

export function slugifyTitle(title: string): string {
	const base = title
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return base.length > 0 ? base.slice(0, 64) : 'collection';
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function makeShareKey(args: { creatorId: string; title: string; now: number }): string {
	const suffix = hashString(`${args.creatorId}:${args.title}:${args.now}`).toString(36).slice(0, 6);
	const creatorSuffix =
		args.creatorId
			.replace(/[^a-zA-Z0-9]/g, '')
			.slice(-6)
			.toLowerCase() || 'user';
	return `${args.now.toString(36)}-${creatorSuffix}-${suffix}`;
}

export function defaultRestrictions(): Restrictions {
	return {
		allowMovies: true,
		allowTV: true,
		allowAnime: true,
		allowNonAnime: true
	};
}

export function normalizeShareAudience(
	visibility: CollectionDoc['visibility'] | 'private' | 'public',
	value: ShareAudience | null | undefined
): ShareAudience {
	if (visibility === 'public') return 'anyone';
	return value ?? 'anyone';
}

export function isCreatorOnlyPrivateCollection(collection: CollectionDoc): boolean {
	return (
		collection.visibility === 'private' &&
		normalizeShareAudience(collection.visibility, collection.shareAudience) === 'creatorOnly'
	);
}

export function validateRestrictions(restrictions: Restrictions): Restrictions {
	if (!restrictions.allowMovies && !restrictions.allowTV) {
		throw new Error('Collections must allow at least one media type.');
	}
	if (!restrictions.allowAnime && !restrictions.allowNonAnime) {
		throw new Error('Collections must allow anime, non-anime, or both.');
	}
	return restrictions;
}

export function defaultTierDefinitions(): Array<{ key: string; label: string }> {
	return [
		{ key: 's', label: 'S' },
		{ key: 'a', label: 'A' },
		{ key: 'b', label: 'B' },
		{ key: 'c', label: 'C' },
		{ key: 'd', label: 'D' },
		{ key: 'f', label: 'F' }
	];
}

export function sanitizeTierInputs(
	tiers: Array<{ key: string; label: string }>
): Array<{ key: string; label: string }> {
	if (tiers.length === 0) throw new Error('Tiered collections must include at least one tier.');
	if (tiers.length > MAX_TIERS) throw new Error(`Collections support at most ${MAX_TIERS} tiers.`);
	const deduped = new Set<string>();
	return tiers.map((tier) => {
		const key = tier.key.trim().toLowerCase();
		const label = tier.label.trim();
		if (key.length === 0) throw new Error('Tier keys are required.');
		if (label.length === 0) throw new Error('Tier labels are required.');
		if (deduped.has(key)) throw new Error('Tier keys must be unique.');
		deduped.add(key);
		return { key, label };
	});
}

export function computePopularityScore(
	collection: Pick<CollectionDoc, 'likeCount' | 'saveCount' | 'commentCount' | 'viewCount'>
): number {
	return (
		collection.viewCount +
		collection.likeCount * 8 +
		collection.saveCount * 12 +
		collection.commentCount * 6
	);
}

export function assertRestrictionsAllowMedia(
	restrictions: Restrictions,
	media: { mediaType: 'movie' | 'tv'; isAnime: boolean }
) {
	if (media.mediaType === 'movie' && !restrictions.allowMovies) {
		throw new Error('This collection does not allow movies.');
	}
	if (media.mediaType === 'tv' && !restrictions.allowTV) {
		throw new Error('This collection does not allow TV series.');
	}
	if (media.isAnime && !restrictions.allowAnime) {
		throw new Error('This collection does not allow anime titles.');
	}
	if (!media.isAnime && !restrictions.allowNonAnime) {
		throw new Error('This collection only allows anime titles.');
	}
}

export function collectionItemLimitErrorMessage() {
	return `This collection has reached its ${MAX_COLLECTION_ITEMS}-item limit.`;
}

export function computeSortOrderBetween(previous: number | null, next: number | null): number {
	if (previous == null && next == null) return ORDER_STEP;
	if (previous == null) {
		if (next == null) return ORDER_STEP;
		return next - ORDER_STEP;
	}
	if (next == null) return previous + ORDER_STEP;
	const midpoint = (previous + next) / 2;
	if (!Number.isFinite(midpoint)) {
		throw new Error('Unable to compute collection order.');
	}
	return midpoint;
}

export function maybeNeedsRebalance(previous: number | null, next: number | null): boolean {
	if (previous == null || next == null) return false;
	return Math.abs(next - previous) < REBALANCE_GAP_MIN;
}
