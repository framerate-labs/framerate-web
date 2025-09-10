import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';

import Header from '@/components/header';
import LibraryGrid from '@/features/library/components/library-grid';
import LibraryGridSkeleton from '@/features/library/components/library-grid-skeleton';
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
  const {
    data: fetchedReviews,
    isFetching,
    error,
  } = useQuery({
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
        {isFetching && <LibraryGridSkeleton />}
        {!isFetching && (error || !Array.isArray(fetchedReviews)) && (
          <div className="bg-background-dark mx-auto mt-20 max-w-lg rounded-md border border-white/10 p-6 text-center">
            <p className="mb-4 text-base font-medium">
              Please log in to view your library.
            </p>
            <Link
              to="/login"
              className="inline-block rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10"
            >
              Go to Login
            </Link>
          </div>
        )}

        {libraryIsReady && fetchedReviews && (
          <LibraryGrid fetchedReviews={fetchedReviews} />
        )}
      </main>
    </>
  );
}
