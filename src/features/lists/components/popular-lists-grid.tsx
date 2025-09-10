import { useQuery } from '@tanstack/react-query';

import PopularListCard from '@/features/lists/components/popular-list-card';
import PopularListCardSkeleton from '@/features/lists/components/popular-list-card-skeleton';
import { getPopularLists } from '@/server/lists';

export default function PopularListsGrid() {
  const { data, isFetching, error } = useQuery({
    queryKey: ['popular-lists'],
    queryFn: () => getPopularLists(24),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  if (error) {
    return (
      <div className="mx-auto py-10 text-center text-sm text-white/70">
        Failed to load popular collections.
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {isFetching &&
          (!data || data.length === 0) &&
          Array.from({ length: 10 }).map((_, i) => (
            <PopularListCardSkeleton key={i} />
          ))}

        {data?.map((item) => (
          <PopularListCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
