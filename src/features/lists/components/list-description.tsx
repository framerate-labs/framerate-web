import type { List, ListItem } from '@/types/lists';

import { useEffect, useState } from 'react';

import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';

import { formatElapsedTime } from '@/lib/time';
import { Route as CollectionPageRoute } from '@/routes/(user)/$username/collections/$slug.index';

type ListData = {
  list: List;
  isLiked: boolean;
  isSaved: boolean;
  listItems: ListItem[];
};

type ListDescriptionProps = {
  listData: ListData | undefined;
};

export default function ListDescription({ listData }: ListDescriptionProps) {
  const [displayData, setDisplayData] = useState<ListData>();

  const { username } = CollectionPageRoute.useParams();

  const [hovering, setHovering] = useState(false);

  // Keep UI in sync with server data after mutations
  useEffect(() => {
    if (listData) {
      setDisplayData(listData);
    }
  }, [listData]);

  return (
    displayData && (
      <div className="mb-8">
        <h2 className="mb-2 h-7 text-xl font-bold">{displayData.list.name}</h2>
        <h3 className="text-gray mb-0.5 font-medium">
          Collection by{' '}
          <Link
            to="/home"
            className="hover:text-foreground font-bold opacity-100 transition-colors duration-200"
          >
            {username}
          </Link>
        </h3>

        <p
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          className="text-medium text-gray relative h-5 w-fit cursor-default text-sm"
        >
          {getElapsedTimeText(hovering, displayData.list)}
        </p>
      </div>
    )
  );
}

function getElapsedTimeText(hovering: boolean, list: List) {
  let elapsedCreateTime = '';
  let elapsedUpdateTime = '';

  try {
    if (list.updatedAt && !elapsedUpdateTime) {
      const updatedAt = formatElapsedTime(list.updatedAt);
      elapsedUpdateTime = updatedAt;
    }

    if (list.createdAt && !elapsedCreateTime) {
      const createdAt = formatElapsedTime(list.createdAt);
      elapsedCreateTime = createdAt;
    }
  } catch (error) {
    if (error instanceof Error) {
      toast.error('Something went wrong while calculating elapsed time!');
    }
  }

  if (hovering && elapsedUpdateTime) {
    return `Published ${elapsedCreateTime} ago`;
  }

  if (elapsedUpdateTime) {
    return `Updated ${elapsedUpdateTime} ago`;
  }

  if (!elapsedUpdateTime) {
    return `Published ${elapsedCreateTime} ago`;
  }
}
