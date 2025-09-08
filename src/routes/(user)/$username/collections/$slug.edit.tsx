import { useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeftCircle } from 'lucide-react';

import EditListForm from '@/features/lists/components/edit-list-form';
import EditListItems from '@/features/lists/components/edit-list-items';
import { sortTitles } from '@/lib/strings';
import { getListData } from '@/server/lists';

export const Route = createFileRoute(
  '/(user)/$username/collections/$slug/edit',
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { username, slug } = Route.useParams();

  const [returnSlug, setReturnSlug] = useState(slug);

  const navigate = useNavigate();

  const { data: listData, error, isFetching } = useQuery({
    queryKey: ['list-items', username, slug],
    queryFn: () => getListData(username, slug),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  const sortedListItems = sortTitles(listData?.listItems);

  function handleClick() {
    navigate({ to: `/${username}/collections/${returnSlug}` });
  }

  useEffect(() => {
    if (!isFetching && error) {
      // If the collection cannot be loaded, navigate back to the view page
      navigate({ to: `/${username}/collections/${slug}`, replace: true });
    }
  }, [error, isFetching, navigate, slug, username]);

  return (
    <div>
      <header className="mt-9 mb-10 flex items-center border-b border-white/[0.08]">
        <h1 className="mb-4 text-[22px] font-semibold">Edit Collection</h1>
      </header>

      <main>
        <button onClick={handleClick}>
          <ArrowLeftCircle
            size={26}
            strokeWidth={1.5}
            className="text-gray mb-6 cursor-pointer transition-colors duration-200 hover:text-white"
          />
        </button>
        {listData && (
          <div className="grid grid-cols-1 gap-5">
            <EditListForm listData={listData} setReturnSlug={setReturnSlug} />

            <section className="bg-background-light flex h-[320px] items-center justify-center rounded-md">
              <p className="text-base font-medium">Image upload coming soon!</p>
            </section>

            <hr className="bg-background my-3" />

            <section className="mb-20">
              <div className="mb-6">
                <h2 className="font-medium">Edit Items</h2>
                <span className="text-gray text-sm tracking-wide">
                  Select poster to remove from list
                </span>
              </div>

              <EditListItems listItems={sortedListItems} username={username} slug={slug} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
