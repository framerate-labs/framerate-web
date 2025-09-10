import { useQuery } from '@tanstack/react-query';

import { getListData } from '@/server/lists';

type PreviewProps = {
  username: string;
  slug: string;
};

export default function PopularListPreview({ username, slug }: PreviewProps) {
  const { data, isFetching } = useQuery({
    queryKey: ['list-preview', username, slug],
    queryFn: () => getListData(username, slug),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const posters = (data?.listItems || [])
    .map((i) => i.posterPath)
    .filter(Boolean)
    .slice(0, 4) as string[];

  if (isFetching && posters.length === 0) {
    return <div className="bg-background-light size-full animate-pulse" />;
  }

  if (posters.length === 0) {
    return (
      <div className="bg-background-light flex size-full items-center justify-center text-xs text-neutral-300">
        No preview
      </div>
    );
  }

  return (
    <div className="bg-background-light grid size-full grid-cols-2 grid-rows-2 gap-[2px]">
      {posters.map((src, idx) => (
        <img
          key={idx}
          src={`https://image.tmdb.org/t/p/w185${src}`}
          alt="Image grid featuring images from the list."
          className="size-full object-cover"
          loading="lazy"
        />
      ))}
    </div>
  );
}
