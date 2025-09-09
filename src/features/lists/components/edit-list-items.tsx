import { useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import Dialog from '@/components/dialog';
import Poster from '@/components/poster';
import { deleteListItem } from '@/server/lists';
import { ListItem } from '@/types/lists';

type EditListItemsProps = {
  listItems: ListItem[] | undefined;
  username: string;
  slug: string;
};

export default function EditListItems({
  listItems,
  username,
  slug,
}: EditListItemsProps) {
  const [selectedItems, setSelectedItems] = useState<number[]>([]);
  const queryClient = useQueryClient();

  function handleClick(id: number) {
    setSelectedItems((prevState) => {
      if (prevState.includes(id)) {
        return prevState.filter((item) => item !== id);
      }

      return [...prevState, id];
    });
  }

  async function handleDelete() {
    for (const item of selectedItems) {
      try {
        await deleteListItem(item);
        toast.success('Removed from list');
      } catch {
        return toast.error('Failed to remove from list');
      }
    }
    // Refresh only the edited list page
    queryClient.invalidateQueries({ queryKey: ['list-items', username, slug] });
  }

  return (
    <div className="relative">
      <div className="grid grid-cols-3 gap-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {listItems &&
          listItems.map((listItem) => {
            return (
              <div
                key={listItem.listItemId}
                onClick={() => handleClick(listItem.listItemId)}
              >
                <div
                  className={`${selectedItems.includes(listItem.listItemId) ? 'before:bg-blue-500/50' : ''} pointer-events-none relative mb-2 aspect-[2/3] w-24 duration-200 ease-in before:absolute before:inset-0 before:z-10 before:rounded before:transition-colors sm:w-28 md:w-32 lg:w-36`}
                >
                  {listItem.posterPath && (
                    <Poster
                      src={listItem.posterPath}
                      fetchSize="w342"
                      title={listItem.title}
                      width={128}
                      height={192}
                      loading="lazy"
                      fetchPriority="auto"
                      perspectiveEnabled={false}
                      classes="absolute inset-0 h-full w-full rounded object-cover"
                    />
                  )}
                </div>
                <p className="pointer-events-none text-[0.8125rem] font-medium tracking-wide">
                  {listItem.title}
                </p>
              </div>
            );
          })}
      </div>

      <Dialog>
        <Dialog.Trigger asChild>
          <button
            className={`${selectedItems.length === 0 && 'hidden'} animate-fade-in ease bg-background hover:bg-background-light fixed right-6 bottom-14 z-50 cursor-pointer rounded-md border border-red-700 px-4 py-2 font-medium transition-colors duration-150 hover:border-red-600`}
          >
            Remove selected
          </button>
        </Dialog.Trigger>
        <Dialog.Content
          title="Remove selected items?"
          description="This action cannot be undone. Selected items will be removed from this list."
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
                Remove
              </button>
            </Dialog.Close>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}
