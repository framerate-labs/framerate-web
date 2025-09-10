import type { List, ListItem } from '@/types/lists';
import type { Dispatch, SetStateAction } from 'react';

import { listSchema } from '../schema/list';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { updateList } from '@/server/lists';
import { useListStore } from '@/store/lists/list-store';

type ListData = {
  list: List;
  isLiked: boolean;
  isSaved: boolean;
  listItems: ListItem[];
};

type EditListProps = {
  listData: ListData | undefined;
  setReturnSlug: Dispatch<SetStateAction<string>>;
};

export default function EditListForm({
  listData,
  setReturnSlug,
}: EditListProps) {
  const addList = useListStore.use.addList();
  const removeList = useListStore.use.removeList();

  const form = useForm<z.infer<typeof listSchema>>({
    resolver: zodResolver(listSchema),
    defaultValues: {
      listName: '',
    },
    mode: 'onChange',
  });

  async function onSubmit(values: z.infer<typeof listSchema>) {
    if (listData) {
      toast.loading('Updating...', { id: 'updating' });
      const updates = { name: values.listName };

      try {
        const updated = await updateList(listData.list.id, updates);
        // After migrating lists to TanStack Query,
        // invalidate lists query instead of changing zustand state
        removeList(updated.id);
        addList(updated);
        setReturnSlug(updated.slug);
        toast.dismiss('updating');
        return toast.success('Collection updated');
      } catch {
        toast.dismiss('updating');
        toast.error(
          'Something went wrong while editing list! Please try again later',
        );
      }
    }
  }

  return (
    listData && (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-md">
          <FormField
            control={form.control}
            name="listName"
            render={({ field }) => (
              <FormItem className="mb-4 space-y-2.5">
                <FormLabel className="text-base">Collection Name</FormLabel>
                <FormControl>
                  <div
                    className={`w-full rounded-md ring-1 ring-white/10 ${form.formState.errors.listName && '!ring-red-500'}`}
                  >
                    <Input
                      placeholder={listData.list.name}
                      autoComplete="off"
                      autoFocus
                      className="bg-background-light text-foreground block w-full rounded-md px-3.5 py-2 outline-none placeholder:text-white/35"
                      {...field}
                    />
                  </div>
                </FormControl>
                <FormDescription className="sr-only">
                  The new name of the list where you will save movies and TV
                  shows.
                </FormDescription>
                <FormMessage className="font-medium text-red-500" />
              </FormItem>
            )}
          />
          <button className="float-right mt-2 cursor-pointer rounded bg-indigo-600 px-4 py-1.5 font-semibold">
            Save
          </button>
        </form>
      </Form>
    )
  );
}
