import { useState } from 'react';

import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';

import { useAuthStore } from '@/store/auth/auth-store';
import { useActiveListStore } from '@/store/lists/active-list-store';
import { useListStore } from '@/store/lists/list-store';

import CreateListForm from './create-list-form';
import ListDialog from './list-dialog';

export default function Sidebar() {
  const { username } = useAuthStore();
  const lists = useListStore.use.lists();
  const setActiveList = useActiveListStore.use.setActiveList();

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <nav className="animate-fade-in bg-background-dark sticky top-10 flex w-full grow flex-col gap-4 overflow-y-auto overflow-x-hidden rounded-lg px-3 py-5">
      <div className="flex items-center justify-between pr-1 pl-2">
        <h2 className="text-left text-lg font-semibold">Your Collections</h2>
        <ListDialog dialogOpen={dialogOpen} setDialogOpen={setDialogOpen}>
          <ListDialog.Trigger asChild>
            <button className="rounded-full p-1 transition-colors duration-150 ease-in hover:bg-white/5">
              <Plus
                strokeWidth={1.5}
                className="text-gray hover:text-foreground relative rounded-full transition-colors duration-150 ease-in"
              />
            </button>
          </ListDialog.Trigger>
          <ListDialog.Content title="Create Collection" description="">
            <CreateListForm setDialogOpen={setDialogOpen} />
          </ListDialog.Content>
        </ListDialog>
      </div>

      <div className="animate-fade-in">
        {lists.length > 0 &&
          lists.map((list) => {
            return (
              <Link
                key={list.id}
                to="/$username/collections/$slug"
                params={{ username, slug: list.slug }}
                activeProps={{ className: '' }}
                onClick={() => setActiveList(list)}
                className="group my-1 flex h-12 items-center justify-between gap-3.5 rounded-md py-1.5 pl-2 transition-colors duration-75 ease-in hover:bg-white/[0.08]"
              >
                <p className="group-hover:text-foreground text-foreground/70 transition-all">
                  {list.name}
                </p>
                <div className="h-8 w-1 rounded-tl rounded-bl bg-indigo-500 opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            );
          })}
      </div>
    </nav>
  );
}
