import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { toast } from 'sonner';

import Header from '@/components/header';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import PopularListsGrid from '@/features/lists/components/popular-lists-grid';
import Sidebar from '@/features/lists/components/sidebar';
import SidebarSkeleton from '@/features/lists/components/sidebar-skeleton';
import { getLists } from '@/server/lists';
import { useListStore } from '@/store/lists/list-store';

export const Route = createFileRoute('/collections')({
  component: CollectionPage,
});

function CollectionPage() {
  const setLists = useListStore.use.setLists();

  const {
    data: userLists,
    isFetching,
    error,
  } = useQuery({
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

  const listsAreReady =
    !isFetching && Array.isArray(userLists) && userLists.length > 0;

  return (
    <div className="size-full">
      <Header title="Collections" />
      {/* Mobile drawer trigger for sidebar */}
      <div className="mb-3 md:hidden">
        <Drawer>
          <DrawerTrigger asChild>
            <button className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium hover:bg-white/10">
              View Your Collections
            </button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader className="sr-only">
              <DrawerTitle>Your Collections</DrawerTitle>
              <DrawerDescription>
                Navigate and manage your lists
              </DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto p-4 pb-4 md:py-0">
              {isFetching && <SidebarSkeleton />}
              {!isFetching && !listsAreReady && (
                <div className="bg-background-dark mx-auto mt-2 max-w-lg rounded-md border border-white/10 p-6 text-center">
                  <p className="mb-4 text-base font-medium">
                    Please log in to view your collections.
                  </p>
                  <Link
                    to="/login"
                    className="inline-block rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10"
                  >
                    Go to Login
                  </Link>
                </div>
              )}
              {listsAreReady && <Sidebar />}
            </div>
          </DrawerContent>
        </Drawer>
      </div>
      <main className="animate-fade-in flex h-[calc(100vh-var(--header-height))] gap-2.5 pb-6">
        <section className="hidden w-[150px] flex-shrink-0 flex-col md:flex md:w-[200px] md:min-w-[200px] lg:w-[240px]">
          {isFetching && <SidebarSkeleton />}
          {!isFetching && !listsAreReady && (
            <div className="bg-background-dark mx-auto mt-2 w-full rounded-md border border-white/10 p-4 text-center">
              <p className="mb-3 text-sm font-medium">
                Please log in to view your collections.
              </p>
              <Link
                to="/login"
                className="inline-block rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/10"
              >
                Go to Login
              </Link>
            </div>
          )}
          {listsAreReady && <Sidebar />}
        </section>

        <section className="scrollbar-hide mx-auto grow overflow-y-auto pr-1">
          <PopularListsGrid />
        </section>
      </main>
    </div>
  );
}
