import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import Header from '@/components/header';
import LibraryGrid from '@/features/library/components/library-grid';
import { getAllReviews } from '@/server/reviews';

type LibraryFilters = {
  filter?: 'film' | 'series';
};

export const Route = createFileRoute('/library')({
  validateSearch: (search: LibraryFilters) => {
    return { filter: search.filter };
  },
  component: Library,
});

function Library() {
  const { data: fetchedReviews, isFetching } = useQuery({
    queryKey: ['library'],
    queryFn: () => getAllReviews(),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  const libraryIsReady = !isFetching && Array.isArray(fetchedReviews);

  return (
    <>
      <Header title="Library" />
      <main className="animate-fade-in">
        {libraryIsReady && fetchedReviews && (
          <LibraryGrid fetchedReviews={fetchedReviews} />
        )}
      </main>
    </>
  );
}
