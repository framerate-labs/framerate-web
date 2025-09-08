import { useEffect, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeftCircle, ArrowUp } from 'lucide-react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';

import Tooltip from '@/components/tooltip';
import { TooltipProvider } from '@/components/ui/tooltip-ui';
// import Backdrop from "@/features/details/components/Backdrop";
import ListDescription from '@/features/lists/components/list-description';
import ListGrid from '@/features/lists/components/list-grid';
import SideCard from '@/features/lists/components/side-card';
import { scrollToTop } from '@/lib/scroll';
import { getListData } from '@/server/lists';
import { useActiveListStore } from '@/store/lists/active-list-store';
import { useListItemStore } from '@/store/lists/list-item-store';

export const Route = createFileRoute('/(user)/$username/collections/$slug/')({
  component: RouteComponent,
});

function RouteComponent() {
  const { username, slug } = Route.useParams();

  const [isArrowVisible, setIsArrowVisible] = useState(false);

  const scrollToTopBtn = useRef<HTMLButtonElement>(null);

  useHotkeys('t', () => {
    scrollToTopBtn.current?.click();
  });

  const setActiveList = useActiveListStore.use.setActiveList();
  const setLikeCount = useActiveListStore.use.setLikeCount();
  const setSaveCount = useActiveListStore.use.setSaveCount();
  const setIsLiked = useActiveListStore.use.setIsLiked();
  const setIsSaved = useActiveListStore.use.setIsSaved();
  const clearActiveList = useActiveListStore.use.clearActiveList();

  const setListItems = useListItemStore.use.setListItems();
  const clearListItems = useListItemStore.use.clearListItems();

  const {
    data: listData,
    isFetching,
    error,
  } = useQuery({
    queryKey: ['list-items', username, slug],
    queryFn: () => getListData(username, slug),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!isFetching) {
      if (listData) {
        setActiveList(listData.list);
        setLikeCount(listData.list.likeCount);
        setSaveCount(listData.list.saveCount);
        setIsLiked(listData.isLiked);
        setIsSaved(listData.isSaved);
        setListItems(listData.listItems);
      } else if (error) {
        toast.error('Failed to load collection');
      }
    }

    return () => {
      clearActiveList();
      clearListItems();
    };
  }, [
    error,
    isFetching,
    listData,
    setActiveList,
    setLikeCount,
    setSaveCount,
    setIsLiked,
    setIsSaved,
    setListItems,
    clearActiveList,
    clearListItems,
  ]);

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          setIsArrowVisible(window.scrollY > 500);
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <main className="pb-20">
      {/* <Backdrop
        collection
        backdropPath="/lvOLivVeX3DVVcwfVkxKf0R22D8.jpg"
        alt="Decorative image describing this collection."
      /> */}
      {/* <div className="relative -top-28 mt-10"> */}
      <div className="relative mt-10">
        <Link to="/collections" aria-label="Back to collections">
          <ArrowLeftCircle
            size={26}
            strokeWidth={1.5}
            className="text-gray mb-6 cursor-pointer transition-colors duration-200 hover:text-white"
          />
        </Link>

        <ListDescription listData={listData} />

        <div className="flex size-full flex-col gap-2.5 md:flex-row">
          <ListGrid listData={listData} isFetching={isFetching} />
          <SideCard listData={listData} />
        </div>
      </div>

      <TooltipProvider>
        <Tooltip side="top" sideOffset={12} content="Scroll to top" key1="T">
          <button
            ref={scrollToTopBtn}
            onClick={scrollToTop}
            className={`${isArrowVisible ? 'animate-fade-in' : ''} fixed right-4 bottom-4 rounded-full p-2 shadow-lg transition-colors duration-200 outline-none hover:bg-white/5 ${
              isArrowVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
            aria-label="Scroll to top"
          >
            <ArrowUp strokeWidth={1.5} />
          </button>
        </Tooltip>
      </TooltipProvider>
    </main>
  );
}
