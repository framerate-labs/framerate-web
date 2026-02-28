import type {
	AniListGraphQLResponse,
	AniListRequestKind,
	AniListRequestMetrics
} from '../../types/anilistTypes';

import { recordAniListAttempt, recordAniListRateLimitHeaders } from './metrics';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';

export async function anilistGraphQL<TData>(
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
