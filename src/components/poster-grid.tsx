import type { ListItem } from '@/types/lists';
import type { Review } from '@/types/ratings';

import { memo } from 'react';

import { Link } from '@tanstack/react-router';

import { StarIcon } from '@/components/icons/star-icon';
import Poster from '@/components/poster';
import Tooltip from '@/components/tooltip';
import { TooltipProvider } from '@/components/ui/tooltip-ui';
import { slugify } from '@/lib/strings';
import { Route as filmRoute } from '@/routes/films/$id.$title';
import { Route as seriesRoute } from '@/routes/series/$id.$title';

type PosterGridProps = {
  media: ListItem[] | Review<'movie' | 'tv'>[];
  isTooltipEnabled?: boolean;
  classes: string;
};

function PosterGrid({ media, isTooltipEnabled, classes }: PosterGridProps) {
  return (
    <div className={`${classes} animate-fade-in-fast grid`}>
      {media &&
        media.map((result, index) => {
          const mediaType = result.mediaType === 'movie' ? 'film' : 'series';
          const route =
            mediaType === 'film' ? filmRoute.fullPath : seriesRoute.fullPath;

          const titleSlug = slugify(result.title);
          const rating = 'rating' in result && parseFloat(result.rating);
          const loadingStrategy = index < 18 ? 'eager' : 'lazy';
          const fetchStrategy = index < 18 ? 'high' : 'low';

          const tooltipContent = (
            <div className="max-w-48">
              <div className="w-full">
                <p className="font-semibold tracking-wide">{result.title}</p>
                <div className="my-1 flex justify-start">
                  <StarIcon fill="#FFD43B" classes="h-4 w-4" />
                  <span className="ml-1 font-semibold">{rating}</span>
                </div>
              </div>
            </div>
          );

          return (
            <TooltipProvider key={`${result.mediaId}-${index}`}>
              <Tooltip
                key={`${result.mediaId}-${index}`}
                sideOffset={25}
                side="bottom"
                content={tooltipContent}
                isEnabled={isTooltipEnabled}
                classes="bg-background-light border-white/10"
              >
                <Link
                  to={route}
                  params={{ id: result.mediaId.toString(), title: titleSlug }}
                  preload={false}
                  className="relative block rounded"
                >
                  <Poster
                    title={result.title}
                    src={result.posterPath}
                    fetchSize="w342"
                    width={160}
                    height={240}
                    perspectiveEnabled={true}
                    loading={loadingStrategy}
                    fetchPriority={fetchStrategy}
                    classes="xl:h-[264px] xl:w-44"
                  />
                </Link>
              </Tooltip>
            </TooltipProvider>
          );
        })}
    </div>
  );
}

function areEqual(prev: PosterGridProps, next: PosterGridProps) {
  if (prev.classes !== next.classes) return false;
  if (prev.isTooltipEnabled !== next.isTooltipEnabled) return false;
  const a = prev.media;
  const b = next.media;
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  // Shallow compare first/last ids to catch common mutations
  const aFirst = a[0]?.mediaId;
  const bFirst = b[0]?.mediaId;
  const aLast = a[a.length - 1]?.mediaId;
  const bLast = b[b.length - 1]?.mediaId;
  return aFirst === bFirst && aLast === bLast;
}

export default memo(PosterGrid, areEqual);
