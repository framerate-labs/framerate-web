import type { MediaDetails } from '@/types/details';
import type { Dispatch, SetStateAction } from 'react';

import { useEffect, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { StarIcon } from '@/components/icons/star-icon';
import { authClient } from '@/lib/auth-client';
import { deleteReview, getReview } from '@/server/reviews';
import { useReviewStore } from '@/store/details/review-store';

type StarRatingProps = {
  media: MediaDetails;
  rating: number | null;
  setRating: Dispatch<SetStateAction<number | null>>;
  handleRating: (rating: number) => Promise<void>;
};

export default function StarRating({
  media,
  rating,
  setRating,
  handleRating,
}: StarRatingProps) {
  const { isWatched, setIsWatched, clearMediaActions } = useReviewStore();
  const [hover, setHover] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const { data: authData } = authClient.useSession();

  const { data: reviewData } = useQuery({
    queryKey: ['review', media.mediaType, media.id],
    queryFn: async () => await getReview(media.mediaType, media.id),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  const groupedStars = [
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [3.5, 4],
    [4.5, 5],
  ];

  useEffect(() => {
    if (reviewData) {
      const dbRating = parseFloat(reviewData.rating);
      setRating(dbRating);
    }

    return () => {
      setRating(null);
    };
  }, [reviewData, setRating]);

  async function handleClick(ratingValue: number) {
    if (rating === ratingValue && authData?.user) {
      const { mediaType, id: mediaId } = media;
      setRating(null);
      setHover(null);
      clearMediaActions();

      try {
        const response = await deleteReview(mediaType, mediaId, queryClient);
        // delete returns null on success
        if (response === null) {
          toast.info('Rating removed');

          queryClient.invalidateQueries({
            queryKey: ['average-rating', media.mediaType, media.id],
          });
          queryClient.invalidateQueries({
            queryKey: ['review', mediaType, mediaId],
          });
          queryClient.invalidateQueries({
            queryKey: ['library'],
          });
          return;
        }
        toast.info('Failed to delete rating! Please try again later');
      } catch {
        toast.info('Failed to delete rating! Please try again later');
      }
    } else {
      if (rating && !isWatched) {
        // if not already marked watched, prevents changing that when user updates rating
        setRating(ratingValue);
        return;
      }
      setRating(ratingValue);
      setIsWatched(true);
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-center gap-1 md:gap-0">
        {groupedStars.map((group, index) => {
          return (
            <span
              key={index}
              className="relative transition-transform duration-100 ease-out hover:scale-[1.15] active:scale-105"
            >
              {group.map((star) => {
                const ratingValue = star;

                return (
                  <label
                    key={ratingValue}
                    className={`${ratingValue % 1 !== 0 ? 'absolute w-[50%] overflow-hidden' : ''}`}
                  >
                    <input
                      type="radio"
                      name="rating"
                      value={ratingValue}
                      aria-label={`Rate ${ratingValue} stars`}
                      onClick={() => {
                        handleClick(ratingValue);
                        if (rating !== ratingValue) handleRating(ratingValue);
                      }}
                      className="hidden"
                    />
                    <StarIcon
                      fill={
                        ratingValue <= (hover || rating!) ? '#FFD43B' : '#333'
                      }
                      classes="size-10 md:w-9 lg:h-8 lg:w-10"
                      onMouseEnter={() => setHover(ratingValue)}
                      onMouseLeave={() => setHover(null)}
                    />
                  </label>
                );
              })}
            </span>
          );
        })}
      </div>
    </div>
  );
}
