import type { SearchBase } from '$types/search';
import type { Trending, TrendingMovie, TrendingTV } from '$types/trending';

/**
 * Converts a TMDB search result (snake_case) to Trending format (camelCase)
 * Preserves type information for movies and TV shows
 */
export function normalizeSearchResult(item: SearchBase): Trending {
	const isMovie = item.media_type === 'movie';
	const isTv = item.media_type === 'tv';

	if (isMovie) {
		const result: TrendingMovie = {
			mediaType: 'movie',
			id: item.id,
			title: item.title || item.name,
			originalTitle: item.original_title || item.original_name,
			releaseDate: item.release_date || item.first_air_date || '',
			posterPath: item.poster_path,
			backdropPath: item.backdrop_path,
			overview: item.overview,
			genreIds: item.genre_ids || [],
			originalLanguage: item.original_language,
			popularity: item.popularity,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			video: false,
			adult: item.adult
		};
		return result;
	}

	if (isTv) {
		const result: TrendingTV = {
			mediaType: 'tv',
			id: item.id,
			title: item.name || item.title,
			originalTitle: item.original_name || item.original_title,
			releaseDate: item.first_air_date || item.release_date || '',
			posterPath: item.poster_path,
			backdropPath: item.backdrop_path,
			overview: item.overview,
			genreIds: item.genre_ids || [],
			originalLanguage: item.original_language,
			popularity: item.popularity,
			voteAverage: item.vote_average,
			voteCount: item.vote_count,
			originCountry: item.origin_country || [],
			adult: item.adult
		};
		return result;
	}

	// Fallback for person or unknown types (shouldn't happen due to filtering)
	throw new Error(`Unexpected media type: ${item.media_type}`);
}
