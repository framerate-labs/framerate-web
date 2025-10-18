export type StoredRating = {
	avgRating: number | null;
	reviewCount: number;
};

export type Review<T> = {
	mediaId: number;
	mediaType: T;
	title: string;
	rating: string;
	posterPath: string | null;
	createdAt: Date;
};
