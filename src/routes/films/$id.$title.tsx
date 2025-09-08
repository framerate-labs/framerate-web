import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';

import { DefaultCatchBoundary } from '@/components/default-catch-boundary';
import Backdrop from '@/features/details/components/backdrop';
import MediaDetails from '@/features/details/components/media-details';
import { getDetails } from '@/server/details';

function createQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['movie-details', id],
    queryFn: () => getDetails('movie', id),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export const Route = createFileRoute('/films/$id/$title')({
  beforeLoad: ({ params }) => {
    // Guard against invalid IDs to avoid bad network calls
    if (!/^\d+$/.test(params.id)) {
      throw redirect({ to: '/home' });
    }
  },
  loader: ({ context, params }) => {
    const detailsQueryOptions = createQueryOptions(params.id);
    return context.queryClient.ensureQueryData(detailsQueryOptions);
  },
  errorComponent: DefaultCatchBoundary,
  component: FilmPage,
});

export default function FilmPage() {
  const { id } = Route.useParams();
  const detailsQueryOptions = createQueryOptions(id);

  const { data: fetchedMovie } = useSuspenseQuery(detailsQueryOptions);

  return (
    fetchedMovie && (
      <>
        <main className="relative pb-32">
          <Backdrop
            alt={`Still image from ${fetchedMovie.title}`}
            backdropPath={fetchedMovie.backdropPath ?? ''}
          />
          <MediaDetails
            media={fetchedMovie}
            title={fetchedMovie.title}
            posterPath={fetchedMovie.posterPath}
          />
        </main>
      </>
    )
  );
}
