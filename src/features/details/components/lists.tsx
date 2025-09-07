import type { MediaDetails } from '@/types/details';
import type { Dispatch, SetStateAction } from 'react';

import { useEffect, useRef } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { BoxIcon } from '@/components/icons/box-icon';
import { CheckBoxIcon } from '@/components/icons/checkbox-icon';
import { addListItem, deleteListItem, getLists } from '@/server/lists';
import { useAuthStore } from '@/store/auth/auth-store';
import { useListStore } from '@/store/lists/list-store';

type SavedToList = {
  listId: number;
  listItemId: number;
  mediaType: string;
  mediaId: number | null;
};

type ListsProps = {
  media: MediaDetails;
  savedToLists: SavedToList[];
  setSavedToLists: Dispatch<SetStateAction<SavedToList[]>>;
};

export default function Lists({
  media,
  savedToLists,
  setSavedToLists,
}: ListsProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  const { username } = useAuthStore();

  const lists = useListStore.use.lists();
  const setLists = useListStore.use.setLists();
  const clearLists = useListStore.use.clearLists();

  const { mediaType, id: mediaId } = media;

  const queryClient = useQueryClient();

  const { data: listsData, isFetching } = useQuery({
    queryKey: ['lists'],
    queryFn: async () => await getLists(),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (!isFetching) {
      if (!listsData) {
        toast.error('Failed to get lists!');
        return;
      }
      setLists(listsData);
    }
  }, [isFetching, listsData, lists.length, setLists, clearLists]);

  async function handleClick(listId: number) {
    const matchedLists = savedToLists.filter(
      (savedList) => savedList.listId === listId,
    );

    // Clicked list does not match a list that the item is saved in (if any)
    if (matchedLists.length === 0) {
      const requestData = { listId, mediaType, mediaId };

      try {
        const result = await addListItem(requestData);
        // result: { created: boolean, item: {...} }
        const item = result.item;
        setSavedToLists((prevState) => {
          const mid = mediaType === 'movie' ? item.movieId : item.seriesId;
          return [
            ...prevState,
            {
              listId: item.listId,
              listItemId: item.id,
              mediaType: item.mediaType,
              mediaId: mid,
            },
          ];
        });
      } catch (err) {
        return toast.error('Failed to add to list');
      }

      toast.success('Added to list');
    }

    // Clicked list matches a list that the item is saved in
    if (matchedLists.length > 0) {
      matchedLists.forEach(async (list) => {
        const { listItemId } = list;
        try {
          await deleteListItem(listItemId);
          const newSavedToLists = savedToLists.filter((l) => l.listId !== listId);
          setSavedToLists(newSavedToLists);
          toast.success('Removed from list');
        } catch {
          return toast.error('Failed to remove from list');
        }
      });
    }

    const listData = lists.filter((list) => list.id === listId)[0];

    if (listData) {
      queryClient.invalidateQueries({
        queryKey: ['list-items', username, listData.slug],
      });
    }
  }

  const idList = savedToLists.map((savedToLists) => savedToLists.listId);

  return (
    lists.length > 0 &&
    lists.map((list) => {
      return (
        <label
          key={list.id}
          className="mb-2.5 flex w-fit cursor-pointer items-center select-none"
        >
          <input
            ref={checkboxRef}
            type="checkbox"
            name="listId"
            value={list.id}
            defaultChecked={idList.includes(list.id)}
            onClick={() => handleClick(list.id)}
            className="peer hidden"
          />
          <CheckBoxIcon
            fillPrimary="#00e4f5"
            fillSecondary="#262626"
            classes="hidden peer-checked:block"
          />
          <BoxIcon fill="#262626" classes="peer-checked:hidden" />
          <span className="ml-1.5">{list.name}</span>
        </label>
      );
    })
  );
}
