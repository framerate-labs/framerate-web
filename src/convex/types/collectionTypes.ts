import type { Doc, Id } from '../_generated/dataModel';

export type CollectionCollaboratorDoc = Doc<'collectionCollaborators'>;
export type CollectionItemDoc = Doc<'collectionItems'>;
export type CollectionTierDoc = Doc<'collectionTiers'>;
export type CollectionViewerInviteDoc = Doc<'collectionViewerInvites'>;
export type UserProfileDoc = Doc<'userProfiles'>;

export type ShareAudience = 'creatorOnly' | 'anyone' | 'friends' | 'followers';
export type CollectionSortDirection = 'ascending' | 'descending';

export type CollectionDoc = Doc<'collections'> & {
	shareAudience?: ShareAudience;
	defaultSortDirection?: CollectionSortDirection;
};

export type ViewerRole = 'creator' | 'collaborator' | 'viewer' | 'none';
export type MyCollectionEntry = { collection: CollectionDoc; role: ViewerRole };

export type CollectionMediaKey =
	| { mediaType: 'movie'; movieId: Id<'movies'> }
	| { mediaType: 'tv'; tvShowId: Id<'tvShows'> };

export type Restrictions = CollectionDoc['restrictions'];
