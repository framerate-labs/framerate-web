import type { QueryClient } from '@tanstack/react-query';
import { HttpError, toHttpError, unwrapData } from '@/lib/http-error';

import { client } from './client-instance';

const reviewRoute = client.api.v1.reviews;
type MediaType = 'movie' | 'tv';

function isValidId(id: number): boolean {
  return Number.isFinite(id) && id > 0;
}

function isValidMediaType(value: string): value is MediaType {
  return value === 'movie' || value === 'tv';
}

function isValidRatingString(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n >= 0.5 && n <= 5;
}

/**
 * Fetch current user review for a specific media item.
 */
export async function getReview(mediaType: MediaType, mediaId: number) {
  if (!isValidMediaType(mediaType)) {
    throw new HttpError(`Invalid mediaType: ${mediaType}`);
  }
  if (!isValidId(mediaId)) {
    throw new HttpError(`Invalid mediaId: ${mediaId}`);
  }

  try {
    const { data, error } = await reviewRoute({ mediaType })({ mediaId }).get();
    if (error) throw toHttpError(error, 'Unable to load review');
    return unwrapData(data);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw toHttpError(err, 'Failed to load review');
  }
}

/**
 * Fetch all reviews for the current user.
 */
export async function getAllReviews() {
  try {
    const { data, error } = await reviewRoute.get();
    if (error) throw toHttpError(error, 'Unable to load reviews');
    return unwrapData(data);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw toHttpError(err, 'Failed to load reviews');
  }
}

/**
 * Fetch average rating for a media item.
 */
export async function getAvgRating(mediaType: MediaType, mediaId: number) {
  if (!isValidMediaType(mediaType)) {
    throw new HttpError(`Invalid mediaType: ${mediaType}`);
  }
  if (!isValidId(mediaId)) {
    throw new HttpError(`Invalid mediaId: ${mediaId}`);
  }

  try {
    const { data, error } = await reviewRoute({ mediaType })({ mediaId }).average.get();
    if (error) throw toHttpError(error, 'Unable to load average rating');
    return unwrapData(data);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw toHttpError(err, 'Failed to load average rating');
  }
}

/**
 * Add or update a rating for a media item.
 */
export async function addReview(
  mediaType: MediaType,
  mediaId: number,
  rating: string,
  qc: QueryClient,
) {
  if (!isValidMediaType(mediaType)) {
    throw new HttpError(`Invalid mediaType: ${mediaType}`);
  }
  if (!isValidId(mediaId)) {
    throw new HttpError(`Invalid mediaId: ${mediaId}`);
  }
  if (!isValidRatingString(rating)) {
    throw new HttpError(`Invalid rating: ${rating}`);
  }

  try {
    const { data, error } = await reviewRoute({ mediaType })({ mediaId }).post({ rating });
    if (error) throw toHttpError(error, 'Unable to add review');
    // qc.invalidateQueries({ queryKey: ["library"] });
    return unwrapData(data);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw toHttpError(err, 'Failed to add review');
  }
}

/**
 * Delete current user review for a media item.
 */
export async function deleteReview(
  mediaType: MediaType,
  mediaId: number,
  qc: QueryClient,
) {
  if (!isValidMediaType(mediaType)) {
    throw new HttpError(`Invalid mediaType: ${mediaType}`);
  }
  if (!isValidId(mediaId)) {
    throw new HttpError(`Invalid mediaId: ${mediaId}`);
  }

  try {
    const { data, error } = await reviewRoute({ mediaType })({ mediaId }).delete();
    if (error) throw toHttpError(error, 'Unable to delete review');
    // qc.invalidateQueries({ queryKey: ["library"] });
    return unwrapData(data);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw toHttpError(err, 'Failed to delete review');
  }
}
