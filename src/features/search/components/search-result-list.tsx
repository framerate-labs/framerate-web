import type { MediaDetails } from '@/types/details';
import type { Trending } from '@/types/trending';

import { useEffect, useState } from 'react';

import { useQueries, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import useDebounce from '@/hooks/use-debounce';
import { getDetails } from '@/server/details';
import { searchMedia } from '@/server/search';
import { getTrending } from '@/server/trending';

import SearchResult from './search-result';

export default function SearchResultList({
  searchQuery,
}: {
  searchQuery: string;
}) {
  const [results, setResults] = useState<Trending[]>([]);
  const debouncedQuery = useDebounce(searchQuery, 300);

  const { data: trendingData, isError: trendingError } = useQuery({
    queryKey: ['all-trending-day'],
    queryFn: () => getTrending({ filter: 'all', timeWindow: 'day' }),
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  const detailsQuery = useQueries({
    queries: results.map((media) => ({
      queryKey: [`${media.mediaType}-details, ${media.id}`],
      queryFn: () => getDetails(media.mediaType, media.id.toString()),
      staleTime: 2 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      enabled: results.length > 0,
    })),
  });

  const controller = new AbortController();
  const searchFnPromise = searchMedia({
    signal: controller.signal,
    data: debouncedQuery,
  });

  const {
    data: searchData,
    isFetching: searchIsFetching,
    error: searchError,
  } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => {
      return searchFnPromise;
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 3 * 60 * 1000,
    enabled: Boolean(debouncedQuery),
  });

  useEffect(() => {
    if (trendingError) {
      toast.error('An error occurred while fetching trending data!', {
        duration: 5000,
      });
      return;
    }

    if (searchError) {
      toast.error('Something went wrong while getting search results!');
      return;
    }

    if (trendingData && !searchIsFetching) {
      setResults(trendingData.slice(0, 10));
    }

    if (searchData !== undefined && searchData.length > 0) {
      setResults(searchData);
    }
  }, [trendingData, trendingError, searchData, searchIsFetching, searchError]);

  useEffect(() => {
    if (detailsQuery.some((queryResult) => queryResult.isError)) {
      toast.error('An error occurred while fetching media details!', {
        duration: 5000,
      });
      return;
    }
  }, [detailsQuery]);

  const detailsData: MediaDetails[] = [];

  if (detailsQuery) {
    detailsQuery.forEach((result) => {
      return result.data && detailsData.push(result.data);
    });
  }

  return (
    <div className="scrollbar-hide bg-background-dark/80 h-2/3 w-full overflow-auto rounded border border-white/10 p-2 shadow-sm backdrop-blur-2xl md:h-[350px] md:rounded-lg">
      {detailsData.map((data) => {
        return (
          <SearchResult key={`${data.mediaType}-${data.id}`} media={data} />
        );
      })}
    </div>
  );
}
