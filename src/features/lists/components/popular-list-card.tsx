import type { PopularList } from '@/types/lists';

import { Link } from '@tanstack/react-router';

import PopularListPreview from './popular-list-preview';

type PopularListProps = {
  item: PopularList;
};

export default function PopularListCard({ item }: PopularListProps) {
  return (
    <Link
      to="/$username/collections/$slug"
      params={{ username: item.username, slug: item.slug }}
      className="group hover:bg-background-light/40 bg-background relative flex flex-col overflow-hidden rounded-lg border border-white/10 transition-colors"
    >
      <div className="h-30 w-full md:h-36 lg:h-44">
        <PopularListPreview username={item.username} slug={item.slug} />
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-foreground line-clamp-2 text-sm font-semibold group-hover:text-white">
            {item.name}
          </h3>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] whitespace-nowrap text-white/80">
            {item.viewCount.toLocaleString()} views
          </span>
        </div>
        <p className="mt-2 text-xs text-white/60">@{item.username}</p>
      </div>
    </Link>
  );
}
