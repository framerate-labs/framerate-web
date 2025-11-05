export type List = {
	type: 'list';
	id: number;
	userId: string;
	name: string;
	likeCount: number;
	saveCount: number;
	createdAt: Date;
	updatedAt: Date | null;
	slug: string;
};

export type ListItem = {
	mediaType: 'movie' | 'tv';
	listId: number;
	mediaId: number;
	listItemId: number;
	title: string;
	posterPath: string | null;
	createdAt: Date;
};

export type ListData =
	| {
			list: List;
			isLiked: boolean;
			isSaved: boolean;
			listItems: ListItem[];
	  }
	| undefined;

export type ActiveList = List;

export type PopularList = List & {
	username: string;
	viewCount: number;
};

export type SavedToList = {
	listId: number;
	listItemId: number;
	mediaType: 'movie' | 'tv';
	mediaId: number | null;
};
