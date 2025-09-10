import type { List, ListItem } from '@/types/lists';

import { useEffect, useState } from 'react';

import PosterGrid from '@/components/poster-grid';

import ListGridSkeleton from './list-grid-skeleton';

type ListData = {
  list: List;
  isLiked: boolean;
  isSaved: boolean;
  listItems: ListItem[];
};

type ListGridProps = {
  listData: ListData | undefined;
  isFetching: boolean;
};

export default function ListGrid({ listData, isFetching }: ListGridProps) {
  const [displayData, setDisplayData] = useState<ListItem[]>();

  // Keep UI in sync with server data after mutations; update when fetch completes
  useEffect(() => {
    if (!isFetching && listData) {
      setDisplayData(listData.listItems);
    }
  }, [listData, isFetching]);

  const showContainerBg = isFetching || (displayData && displayData.length > 0);

  return (
    <section
      className={`${showContainerBg ? 'bg-background-dark overflow-auto border border-white/10' : ''} order-2 rounded-md p-3 md:order-1 md:w-4/5 md:p-4 lg:p-6`}
    >
      {isFetching && <ListGridSkeleton />}

      {displayData && displayData.length > 0 && (
        <PosterGrid
          media={displayData}
          isTooltipEnabled={false}
          classes="grid-cols-3 gap-2 md:grid-cols-4 lg:grid-cols-5 lg:gap-3.5"
        />
      )}
      {(!isFetching && !displayData) ||
        (displayData?.length === 0 && (
          <div className="flex size-full items-center justify-center">
            <p className="font-medium">
              Add your first film or series to this collection!
            </p>
          </div>
        ))}
    </section>
  );
}
