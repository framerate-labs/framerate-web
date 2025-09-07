import type { List, ListItem } from '@/types/lists';

import { useEffect, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import Dialog from '@/components/dialog';
import {
  BookmarkIcon,
  HeartIcon,
} from '@/components/icons/media-actions-icons';
import { authClient } from '@/lib/auth-client';
import { Route as CollectionPageRoute } from '@/routes/(user)/$username/collections/$slug.index';
import { addListAction, deleteListAction } from '@/server/actions';
import { deleteList } from '@/server/lists';
import { useListStore } from '@/store/lists/list-store';

type ListData = {
  list: List;
  isLiked: boolean;
  isSaved: boolean;
  listItems: ListItem[];
};

type SideCardProps = {
  listData: ListData | undefined;
};

export default function SideCard({ listData }: SideCardProps) {
  const [displayData, setDisplayData] = useState<ListData>();
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [saveCount, setSaveCount] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const { username, slug } = CollectionPageRoute.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const activeUser = authClient.useSession();

  const removeList = useListStore.use.removeList();

  const formatter = Intl.NumberFormat('en', { notation: 'compact' });

  // This method of assigning query data to local state is necessary to prevent
  // component flashing when the cache is invalidated due to list actions (like/save)
  useEffect(() => {
    if (listData && !initialDataLoaded) {
      setDisplayData(listData);
      setInitialDataLoaded(true);
      setLikeCount(listData.list.likeCount);
      setSaveCount(listData.list.saveCount);
      setIsLiked(listData.isLiked);
      setIsSaved(listData.isSaved);
    }
  }, [listData, initialDataLoaded, setIsLiked, setIsSaved]);

  async function updateLike() {
    if (displayData) {
      const list = displayData.list;

      if (!isLiked) {
        setLikeCount((v) => v + 1);
        setIsLiked(true);
        try {
          await addListAction(list.id, 'like');
        } catch {
          toast.error('Failed to like list! Please try again later');
          setLikeCount((v) => v - 1);
          setIsLiked(false);
        }
      } else {
        setLikeCount((v) => v - 1);
        setIsLiked(false);
        try {
          await deleteListAction(list.id, 'like');
        } catch {
          toast.error('Failed to unlike list! Please try again later');
          setLikeCount((v) => v + 1);
          setIsLiked(true);
        }
      }

      queryClient.invalidateQueries({
        queryKey: ['list-items', username, list.name.toLowerCase()],
      });
    }
  }

  async function updateSave() {
    if (displayData) {
      const list = displayData.list;

      if (!isSaved) {
        setSaveCount((v) => v + 1);
        setIsSaved(true);
        try {
          await addListAction(list.id, 'save');
        } catch {
          toast.error('Failed to save list! Please try again later');
          setSaveCount((v) => v - 1);
          setIsSaved(false);
        }
      } else {
        setSaveCount((v) => v - 1);
        setIsSaved(false);
        try {
          await deleteListAction(list.id, 'save');
        } catch {
          toast.error('Failed to unsave list! Please try again later');
          setSaveCount((v) => v + 1);
          setIsSaved(true);
        }
      }

      queryClient.invalidateQueries({
        queryKey: ['list-items', username, list.name.toLowerCase()],
      });
    }
  }

  async function handleDelete() {
    if (displayData) {
      try {
        const deleted = await deleteList(displayData.list.id);
        removeList(deleted.id);
        toast.success('List deleted');
        queryClient.invalidateQueries({ queryKey: ['lists'] });
        navigate({ to: '/collections' });
      } catch {
        toast.error('Failed to delete list! Please try again later');
      }
    }
  }

  return (
    displayData && (
      <aside className="bg-background relative order-1 flex h-40 grow flex-col items-center justify-between rounded-md border border-white/5 px-7 py-8 shadow-md md:order-2">
        {activeUser.data &&
          displayData.list.userId === activeUser.data.user.id && (
            <div className="mb-6 flex gap-3">
              <Link
                to="/$username/collections/$slug/edit"
                params={{ username, slug }}
                className="transiton-colors ease rounded-md border border-white/5 bg-[#28292d] px-4 py-2 font-medium duration-150 hover:border-white/10 hover:bg-transparent"
              >
                Edit
              </Link>
              <Dialog>
                <Dialog.Trigger asChild>
                  <button className="ease cursor-pointer rounded-md border border-white/5 bg-[#28292d] px-4 py-2 font-medium transition-colors duration-150 hover:border-red-500 hover:bg-transparent">
                    Delete
                  </button>
                </Dialog.Trigger>
                <Dialog.Content
                  title="Delete this list?"
                  description="This action cannot be undone. This will permanently delete your
                      list and its content, including metadata such as likes, saves, and views."
                >
                  <Dialog.Footer>
                    <Dialog.Close asChild>
                      <button className="hover:text-foreground text-foreground border-background-light hover:bg-background-light inline-flex h-9 cursor-pointer items-center justify-center rounded-md border bg-transparent px-4 py-2 text-sm font-medium transition-colors">
                        Cancel
                      </button>
                    </Dialog.Close>
                    <Dialog.Close asChild>
                      <button
                        onClick={handleDelete}
                        className="text-foreground inline-flex h-9 cursor-pointer items-center justify-center rounded-md border-red-800 bg-red-700 px-4 py-2 text-sm font-medium transition-colors hover:bg-red-800"
                      >
                        Delete
                      </button>
                    </Dialog.Close>
                  </Dialog.Footer>
                </Dialog.Content>
              </Dialog>
            </div>
          )}

        <div className="flex items-center justify-around gap-10 text-[#555] md:w-full md:gap-3">
          <div className="flex items-center justify-center gap-2">
            <HeartIcon
              fill="#333"
              classes={`${isLiked && 'fill-[#FF153A]'} hover:fill-[#FF153A] cursor-pointer ease transition-all duration-150 active:scale-90 h-6`}
              onClick={() => updateLike()}
            />
            <p className="cursor-default">{formatter.format(likeCount)}</p>
          </div>

          <div className="flex items-center justify-center gap-2">
            <BookmarkIcon
              fill="#333"
              classes={`${isSaved && 'fill-[#32EC44]'} hover:fill-[#32EC44] cursor-pointer ease transition-all duration-150 active:scale-90 h-6`}
              onClick={() => updateSave()}
            />
            <p className="cursor-default">{formatter.format(saveCount)}</p>
          </div>
        </div>
      </aside>
    )
  );
}
