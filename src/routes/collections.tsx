import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

import Header from '@/components/header';
import Sidebar from '@/features/lists/components/sidebar';
import { getLists } from '@/server/lists';
import { useListStore } from '@/store/lists/list-store';

export const Route = createFileRoute('/collections')({
  component: CollectionPage,
});

function CollectionPage() {
  const setLists = useListStore.use.setLists();

  const { data: userLists, isFetching, error } = useQuery({
    queryKey: ['lists'],
    queryFn: () => getLists(),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (!isFetching && error) {
      toast.error('Failed to load your collections');
    }
  }, [error, isFetching]);

  useEffect(() => {
    if (userLists) {
      setLists(userLists);
    }
  }, [userLists, setLists]);

  const listsAreReady = !isFetching && Array.isArray(userLists) && userLists.length > 0;

  return (
    <div className="size-full">
      <Header title="Collections" />
      <main className="animate-fade-in flex h-[calc(100vh-var(--header-height))] gap-2.5 pb-6">
        <section className="flex w-[250px] flex-col">
          {listsAreReady && <Sidebar />}
        </section>

        <section className="mx-auto grow text-center font-medium">
          <p>Collection discovery coming soon</p>
        </section>
      </main>
    </div>
  );
}
