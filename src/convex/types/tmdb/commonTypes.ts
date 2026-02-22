export type TMDBErrorPayload = {
	status_message?: unknown;
	status_code?: unknown;
};

export type TMDBFetchOptions = {
	params?: Record<string, string | number | boolean | null | undefined>;
};
