import type { SearchResults } from '@/types/search';

import { createServerFn } from '@tanstack/react-start';
import { objectToCamel } from 'ts-case-convert';

import { HttpError, toHttpError } from '@/lib/http-error';

/**
 * Search TMDB for movies and TV shows.
 * - Filters out people results client-side.
 * - Requires `API_TOKEN` in server environment.
 */
export const searchMedia = createServerFn({ method: 'GET' })
  .validator((query: string) => query)
  .handler(async ({ signal, data }) => {
    if (signal.aborted) return;

    const API_TOKEN = process.env.API_TOKEN;
    if (!API_TOKEN) {
      throw new HttpError('Server misconfiguration: API_TOKEN missing');
    }

    const rawQuery = typeof data === 'string' ? data : '';
    const query = rawQuery.trim();

    // Short-circuit empty or too-long queries to avoid wasted requests
    if (query.length === 0) return [];
    if (query.length > 100) {
      throw new HttpError('Query too long (max 100 characters)');
    }

    const params = new URLSearchParams({
      query,
      include_adult: 'false',
      language: 'en-US',
      page: '1',
    });

    const url = `https://api.themoviedb.org/3/search/multi?${params}`;

    function isNonPerson(item: unknown): boolean {
      if (
        item &&
        typeof item === 'object' &&
        'mediaType' in (item as Record<string, unknown>)
      ) {
        const mt = (item as { mediaType?: unknown }).mediaType;
        return mt !== 'person';
      }
      // If shape is unknown, keep the item rather than over-filtering
      return true;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new HttpError(
            'TMDB rate limit exceeded. Try again later.',
            429,
          );
        }
        let message = 'Search request failed';
        try {
          const body = (await response.json()) as { status_message?: string };
          if (body?.status_message) message = body.status_message;
        } catch {
          // ignore JSON parsing errors
        }
        throw new HttpError(message, response.status);
      }

      const rawData = (await response.json()) as unknown as SearchResults;
      const transformedData = objectToCamel(rawData);
      const searchResults = transformedData.results.slice(0, 10);
      const filteredResults = searchResults.filter(isNonPerson);
      return filteredResults;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw toHttpError(err, 'Failed to perform search');
    }
  });
