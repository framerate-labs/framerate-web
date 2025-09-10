import type { MediaDetails } from '@/types/details';

import { useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  BookmarkIcon,
  EyeIcon,
  HeartIcon,
  // PenIcon,
} from '@/components/icons/media-actions-icons';
import Tooltip from '@/components/tooltip';
import { TooltipProvider } from '@/components/ui/tooltip-ui';
import CreateList from '@/features/details/components/create-list';
import Lists from '@/features/details/components/lists';
import ListsModal from '@/features/details/components/lists-modal';
import { useMediaActions } from '@/hooks/use-media-actions';
import { authClient } from '@/lib/auth-client';
import { getListItem } from '@/server/lists';
import { getReview } from '@/server/reviews';
import { useReviewStore } from '@/store/details/review-store';

type SavedToList = {
  listId: number;
  listItemId: number;
  mediaType: string;
  mediaId: number | null;
};

type ActionType = 'like' | 'watch' | 'review';

const actions = [
  {
    id: 1,
    name: 'like' as const,
    content: 'Like',
    icon: HeartIcon,
    active: 'fill-[#FF153A]',
    hover: 'hover:fill-[#FF153A]',
  },
  {
    id: 2,
    name: 'watch' as const,
    content: 'Mark watched',
    icon: EyeIcon,
    active: 'fill-[#00e4f5]',
    hover: 'hover:fill-[#00e4f5]',
  },
  // {
  //   id: 4,
  //   name: 'review' as const,
  //   content: 'Review',
  //   icon: PenIcon,
  //   active: 'fill-[#7468F3]',
  //   hover: 'hover:fill-[#7468F3]',
  // },
];

export default function MediaActions({ media }: Record<'media', MediaDetails>) {
  const [savedToLists, setSavedToLists] = useState<SavedToList[]>([]);

  const setIsLiked = useReviewStore.use.setIsLiked();
  const setIsWatched = useReviewStore.use.setIsWatched();

  const { data: authData } = authClient.useSession();

  const { id: mediaId, mediaType } = media;

  const { data: reviewData } = useQuery({
    queryKey: ['review', mediaType, mediaId],
    queryFn: async () => await getReview(mediaType, mediaId),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    onError: () => {
      // Prompt login instead of showing an error when unauthenticated
      toast.info('Log in to track likes and watched status');
    },
  });

  const { isLiked, isWatched, debouncedHandleClick } = useMediaActions(
    mediaType,
    mediaId,
    reviewData,
  );

  useEffect(() => {
    return () => {
      setIsLiked(false);
      setIsWatched(false);
    };
  }, [setIsLiked, setIsWatched]);

  useEffect(() => {
    async function fetchListItem() {
      try {
        const savedMedia = await getListItem(mediaType, mediaId);
        if (savedMedia) {
          setSavedToLists((prevState) => [...prevState, savedMedia]);
        }
      } catch (err) {
        // When logged out, prompt to log in instead of erroring
        toast.info('Log in to save to your collections');
      }
    }

    fetchListItem();

    return () => setSavedToLists([]);
  }, [mediaId, mediaType]);

  async function handleClick(actionName: ActionType) {
    if (actionName === 'review') {
      toast.error('Reviews are not supported yet!');
      return;
    }

    const user = authData?.user;

    if (!user || !user.id) {
      toast.info('Please log in to continue');
      return;
    }

    if (reviewData == null) {
      toast.info('Please submit a rating first');
      return;
    }

    if (actionName === 'like') {
      setIsLiked(!isLiked);
      return debouncedHandleClick(actionName, !isLiked);
    } else {
      setIsWatched(!isWatched);
      return debouncedHandleClick(actionName, !isWatched);
    }
  }

  return (
    <div className="mt-3 flex w-full items-center justify-evenly gap-0 px-1.5">
      <TooltipProvider>
        {actions.map((action) => {
          const Icon = action.icon;

          const isActive =
            (action.name === 'like' && isLiked) ||
            (action.name === 'watch' && isWatched);

          return (
            <Tooltip
              key={action.id}
              side="top"
              sideOffset={12}
              content={action.content}
            >
              {/* Div is necessary for tooltip to work */}
              <div>
                <Icon
                  fill="#333"
                  classes={`${action.hover} ${isActive && action.active} cursor-pointer ease transition-all duration-150 active:scale-90 h-8`}
                  onClick={() => handleClick(action.name)}
                />
              </div>
            </Tooltip>
          );
        })}

        <ListsModal>
          <Tooltip side="top" sideOffset={12} content={'Save'}>
            <ListsModal.Trigger asChild>
              {/* Div is necessary for tooltip to work */}
              <div>
                <BookmarkIcon
                  fill="#333"
                  classes={`${savedToLists.length > 0 && 'fill-[#32EC44]'} cursor-pointer hover:fill-[#32EC44] h-8`}
                />
              </div>
            </ListsModal.Trigger>
          </Tooltip>

          <ListsModal.Content
            title="Update Collections"
            description="Save or remove content from your collections"
          >
            <div className="animate-fade-in">
              <CreateList />
              <Lists
                media={media}
                savedToLists={savedToLists}
                setSavedToLists={setSavedToLists}
              />
            </div>
          </ListsModal.Content>
        </ListsModal>
      </TooltipProvider>
    </div>
  );
}
