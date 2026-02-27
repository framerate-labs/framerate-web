import type {
	AniListDateParts,
	AniListMediaCore,
	AniListStudio,
	AniListWatchLink
} from '../types/animeTypes';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';

type AniListGraphQLError = {
	message?: string;
	status?: number;
};

type AniListGraphQLResponse<T> = {
	data?: T;
	errors?: AniListGraphQLError[];
};

export type AniListRequestMetrics = {
	requestAttempts: number;
	rateLimitedResponses: number;
	retries: number;
	searchRequests: number;
	mediaRequests: number;
	lastRateLimitLimit?: number | null;
	lastRateLimitRemaining?: number | null;
	minRateLimitRemaining?: number | null;
	lastRateLimitResetAtMs?: number | null;
	lastRetryAfterMs?: number | null;
};

export type AniListRateLimitHints = {
	limit?: number;
	remaining?: number;
	resetAtMs?: number;
	retryAfterMs?: number;
};

type AniListRequestKind = 'search' | 'media';

export function createAniListRequestMetrics(): AniListRequestMetrics {
	return {
		requestAttempts: 0,
		rateLimitedResponses: 0,
		retries: 0,
		searchRequests: 0,
		mediaRequests: 0,
		lastRateLimitLimit: null,
		lastRateLimitRemaining: null,
		minRateLimitRemaining: null,
		lastRateLimitResetAtMs: null,
		lastRetryAfterMs: null
	};
}

function recordAniListAttempt(
	metrics: AniListRequestMetrics | undefined,
	kind: AniListRequestKind
) {
	if (!metrics) return;
	metrics.requestAttempts += 1;
	if (kind === 'search') metrics.searchRequests += 1;
	else metrics.mediaRequests += 1;
}

function parsePositiveHeaderNumber(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

function parseAniListResetHeaderMs(value: string | null): number | null {
	const parsed = parsePositiveHeaderNumber(value);
	if (parsed == null) return null;
	// AniList docs report Unix timestamp (seconds). Be defensive if milliseconds are returned.
	return parsed >= 1_000_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
}

function recordAniListRateLimitHeaders(
	metrics: AniListRequestMetrics | undefined,
	response: Response
) {
	if (!metrics) return;
	const limit = parsePositiveHeaderNumber(response.headers.get('x-ratelimit-limit'));
	if (limit != null) metrics.lastRateLimitLimit = Math.floor(limit);

	const remaining = parsePositiveHeaderNumber(response.headers.get('x-ratelimit-remaining'));
	if (remaining != null) {
		const normalized = Math.max(0, Math.floor(remaining));
		metrics.lastRateLimitRemaining = normalized;
		metrics.minRateLimitRemaining =
			metrics.minRateLimitRemaining == null
				? normalized
				: Math.min(metrics.minRateLimitRemaining, normalized);
	}

	const resetAtMs = parseAniListResetHeaderMs(response.headers.get('x-ratelimit-reset'));
	if (resetAtMs != null) metrics.lastRateLimitResetAtMs = resetAtMs;

	const retryAfterSeconds = parsePositiveHeaderNumber(response.headers.get('retry-after'));
	if (retryAfterSeconds != null) {
		metrics.lastRetryAfterMs = Math.max(1000, Math.floor(retryAfterSeconds * 1000));
	}
}

export function summarizeAniListRateLimitHints(
	metrics: AniListRequestMetrics
): AniListRateLimitHints | null {
	const hints: AniListRateLimitHints = {};
	if (
		typeof metrics.lastRateLimitLimit === 'number' &&
		Number.isFinite(metrics.lastRateLimitLimit)
	) {
		hints.limit = Math.max(1, Math.floor(metrics.lastRateLimitLimit));
	}
	const remainingCandidate =
		typeof metrics.minRateLimitRemaining === 'number' &&
		Number.isFinite(metrics.minRateLimitRemaining)
			? metrics.minRateLimitRemaining
			: metrics.lastRateLimitRemaining;
	if (typeof remainingCandidate === 'number' && Number.isFinite(remainingCandidate)) {
		hints.remaining = Math.max(0, Math.floor(remainingCandidate));
	}
	if (
		typeof metrics.lastRateLimitResetAtMs === 'number' &&
		Number.isFinite(metrics.lastRateLimitResetAtMs)
	) {
		hints.resetAtMs = Math.max(0, Math.floor(metrics.lastRateLimitResetAtMs));
	}
	if (typeof metrics.lastRetryAfterMs === 'number' && Number.isFinite(metrics.lastRetryAfterMs)) {
		hints.retryAfterMs = Math.max(1000, Math.floor(metrics.lastRetryAfterMs));
	}
	return Object.keys(hints).length > 0 ? hints : null;
}

function toAniListDateParts(value: unknown): AniListDateParts | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	return {
		year: typeof row.year === 'number' ? row.year : null,
		month: typeof row.month === 'number' ? row.month : null,
		day: typeof row.day === 'number' ? row.day : null
	};
}

function normalizeStudios(value: unknown): AniListStudio[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as Record<string, unknown>;
	const nodes = Array.isArray(row.nodes) ? row.nodes : [];
	const edges = Array.isArray(row.edges) ? row.edges : [];
	const studios: AniListStudio[] = [];

	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!node || typeof node !== 'object') continue;
		const studio = node as Record<string, unknown>;
		const id = typeof studio.id === 'number' ? studio.id : null;
		const name = typeof studio.name === 'string' ? studio.name.trim() : '';
		if (id === null || name.length === 0) continue;

		const edge =
			index < edges.length && edges[index] && typeof edges[index] === 'object'
				? (edges[index] as Record<string, unknown>)
				: null;
		studios.push({
			anilistStudioId: id,
			name,
			isAnimationStudio:
				typeof studio.isAnimationStudio === 'boolean' ? studio.isAnimationStudio : undefined,
			isMain: edge && typeof edge.isMain === 'boolean' ? edge.isMain : undefined
		});
	}

	return studios;
}

function normalizeWatchLinks(value: unknown): AniListWatchLink[] {
	if (!Array.isArray(value)) return [];
	const links: AniListWatchLink[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		const url = typeof row.url === 'string' ? row.url.trim() : '';
		const site = typeof row.site === 'string' ? row.site.trim() : '';
		if (url.length === 0 || site.length === 0) continue;
		links.push({
			title: typeof row.title === 'string' ? row.title : null,
			thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
			url,
			site
		});
	}
	return links;
}

function normalizeMediaCore(value: unknown): AniListMediaCore | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const id = typeof row.id === 'number' ? row.id : null;
	if (id === null) return null;

	const titleRaw =
		row.title && typeof row.title === 'object' ? (row.title as Record<string, unknown>) : {};
	return {
		id,
		type: typeof row.type === 'string' ? row.type : null,
		title: {
			romaji: typeof titleRaw.romaji === 'string' ? titleRaw.romaji : null,
			english: typeof titleRaw.english === 'string' ? titleRaw.english : null,
			native: typeof titleRaw.native === 'string' ? titleRaw.native : null
		},
		format: typeof row.format === 'string' ? row.format : null,
		status: typeof row.status === 'string' ? row.status : null,
		startDate: toAniListDateParts(row.startDate),
		endDate: toAniListDateParts(row.endDate),
		seasonYear: typeof row.seasonYear === 'number' ? row.seasonYear : null,
		episodes: typeof row.episodes === 'number' ? row.episodes : null,
		description: typeof row.description === 'string' ? row.description : null,
		studios: normalizeStudios(row.studios),
		watchLinks: normalizeWatchLinks(row.streamingEpisodes)
	};
}

async function anilistGraphQL<TData>(
	query: string,
	variables: Record<string, unknown>,
	options?: { metrics?: AniListRequestMetrics; kind?: AniListRequestKind }
): Promise<TData> {
	let lastError: unknown = null;
	const metrics = options?.metrics;
	const kind = options?.kind ?? 'media';

	for (let attempt = 0; attempt < 3; attempt += 1) {
		recordAniListAttempt(metrics, kind);
		const response = await fetch(ANILIST_GRAPHQL_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: JSON.stringify({ query, variables })
		});
		recordAniListRateLimitHeaders(metrics, response);

		if (response.status === 429 && attempt < 2) {
			if (metrics) {
				metrics.rateLimitedResponses += 1;
				metrics.retries += 1;
			}
			const waitMs = metrics?.lastRetryAfterMs ?? 1000;
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			continue;
		}

		let payload: AniListGraphQLResponse<TData> | null = null;
		try {
			payload = (await response.json()) as AniListGraphQLResponse<TData>;
		} catch (error) {
			lastError = error;
		}

		if (!response.ok) {
			const msg =
				payload?.errors
					?.map((error) => error.message)
					.filter(Boolean)
					.join('; ') || `AniList API error ${response.status}`;
			lastError = new Error(msg);
			if (response.status >= 500 && attempt < 2) {
				if (metrics) metrics.retries += 1;
				continue;
			}
			break;
		}

		if (!payload?.data) {
			const msg =
				payload?.errors
					?.map((error) => error.message)
					.filter(Boolean)
					.join('; ') || 'AniList API returned no data';
			throw new Error(msg);
		}

		return payload.data;
	}

	throw lastError instanceof Error ? lastError : new Error('AniList request failed');
}

const ANILIST_MEDIA_FIELDS = `
  id
  type
  title { romaji english native }
  format
  status
  startDate { year month day }
  endDate { year month day }
  seasonYear
  episodes
  description(asHtml: false)
  studios {
    edges { isMain }
    nodes { id name isAnimationStudio }
  }
  streamingEpisodes {
    title
    thumbnail
    url
    site
  }
`;

const ANILIST_SEARCH_FIELDS = `
  id
  type
  title { romaji english native }
  format
  status
  startDate { year month day }
  endDate { year month day }
  seasonYear
  episodes
  studios {
    edges { isMain }
    nodes { id name isAnimationStudio }
  }
`;

const SEARCH_ANIME_QUERY = `
query SearchAnime($search: String!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: [POPULARITY_DESC]) {
      ${ANILIST_SEARCH_FIELDS}
    }
  }
}
`;

const MEDIA_BY_ID_QUERY = `
query AnimeMediaByIdForEnrichment($id: Int!) {
  Media(id: $id, type: ANIME) {
    ${ANILIST_MEDIA_FIELDS}
  }
}
`;

export async function searchAniListAnimeCandidates(
	search: string,
	perPage = 10,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore[]> {
	const cleaned = search.trim();
	if (cleaned.length === 0) return [];

	const data = await anilistGraphQL<{
		Page?: {
			media?: unknown[];
		};
	}>(
		SEARCH_ANIME_QUERY,
		{
			search: cleaned,
			perPage
		},
		{ metrics, kind: 'search' }
	);

	const mediaRows = Array.isArray(data.Page?.media) ? data.Page?.media : [];
	const normalized: AniListMediaCore[] = [];
	for (const media of mediaRows ?? []) {
		const row = normalizeMediaCore(media);
		if (row) normalized.push(row);
	}
	return normalized;
}

export async function fetchAniListAnimeMediaById(
	id: number,
	metrics?: AniListRequestMetrics
): Promise<AniListMediaCore> {
	const data = await anilistGraphQL<{
		Media?: unknown;
	}>(MEDIA_BY_ID_QUERY, { id }, { metrics, kind: 'media' });

	const media = normalizeMediaCore(data.Media);
	if (!media) {
		throw new Error(`AniList Media ${id} not found or invalid`);
	}
	return media;
}
