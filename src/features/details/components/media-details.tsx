import type { MediaDetails } from '@/types/details';

import Poster from '@/components/poster';

import Credits from './credits';
import ReviewCard from './review-card';

type MediaDetailsProps = {
  media: MediaDetails;
  title: string;
  posterPath: string | null;
};

export default function MediaDetails({
  media,
  title,
  posterPath,
}: MediaDetailsProps) {
  return (
    <>
      <div className="-mt-14 grid w-full grid-cols-3 md:-mt-44 md:grid-rows-2 lg:grid-cols-4 lg:grid-rows-none">
        <aside className="md-tablet:col-end-3 order-2 col-start-3 h-48 w-32 shrink-0 md:order-1 md:col-start-1 md:mt-0 md:mr-6 md:h-[300px] md:w-[200px] lg:col-end-2 lg:h-[345px] lg:w-[230px] xl:mr-16">
          <Poster
            title={title}
            src={posterPath ? posterPath : media.posterPath}
            fetchSize="w500"
            width={230}
            height={345}
            perspectiveEnabled={true}
            sizes="(min-width: 1280px) 230px, (min-width: 1024px) 200px, (min-width: 768px) 180px, 160px"
            loading="eager"
            classes="w-full h-auto"
          />
        </aside>

        <div className="order-1 col-start-1 col-end-3 flex h-fit grow basis-2/3 flex-col items-baseline px-2 pr-3 text-[#e9e2e3] md:order-2 md:col-start-2 md:col-end-5 md:px-0 md:pr-0 lg:col-start-2 lg:col-end-4 lg:row-start-1 lg:ml-0">
          <Credits
            title={title}
            director={media.mediaType === 'movie' && media.director}
            creator={media.mediaType === 'tv' ? media.creator : ''}
            releaseDate={media.releaseDate}
          />

          <div className="col-start-1 col-end-4 row-start-2 mt-5 w-full md:order-3 md:mt-3 md:pr-6 lg:mt-6 lg:w-11/12 lg:pr-0 xl:w-4/5">
            <h3 className="text-sm font-medium tracking-wide text-balance uppercase">
              {media.tagline}
            </h3>
            <p className="mt-2 text-sm leading-normal font-medium tracking-wider text-pretty md:text-base md:tracking-wide lg:mt-4">
              {media.overview}
            </p>
          </div>
        </div>

        <div className="order-4 col-span-3 col-start-1 mx-auto mt-[52px] w-2/3 self-start md:w-[80%] lg:col-start-4">
          <ReviewCard media={media} />
        </div>
      </div>
    </>
  );
}
