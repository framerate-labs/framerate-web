import type {
	HeaderContributorInput,
	InsertMediaArgs,
	MovieInsertDoc,
	MoviePatch,
	SyncPolicy,
	TVInsertDoc,
	TVPatch,
	StoredMovieDoc,
	StoredTVDoc
} from '../types/detailsType';

import {
	sameEpisodeSummary,
	sameHeaderContributors,
	shouldApplySyncPolicy
} from '../services/detailsService';

type MovieSyncPolicyMap = {
	title: SyncPolicy;
	posterPath: SyncPolicy;
	backdropPath: SyncPolicy;
	releaseDate: SyncPolicy;
	overview: SyncPolicy;
	status: SyncPolicy;
	runtime: SyncPolicy;
	isAnime: SyncPolicy;
	director: SyncPolicy;
	creatorCredits: SyncPolicy;
};

type TVSyncPolicyMap = {
	title: SyncPolicy;
	posterPath: SyncPolicy;
	backdropPath: SyncPolicy;
	releaseDate: SyncPolicy;
	overview: SyncPolicy;
	status: SyncPolicy;
	numberOfSeasons: SyncPolicy;
	lastAirDate: SyncPolicy;
	lastEpisodeToAir: SyncPolicy;
	nextEpisodeToAir: SyncPolicy;
	isAnime: SyncPolicy;
	creator: SyncPolicy;
	creatorCredits: SyncPolicy;
};

function assignSourceIdentifier(
	doc: { tmdbId?: number; traktId?: number; imdbId?: string },
	args: Pick<InsertMediaArgs, 'source' | 'externalId'>
): void {
	if (args.source === 'tmdb') {
		doc.tmdbId = args.externalId as number;
		return;
	}
	if (args.source === 'trakt') {
		doc.traktId = args.externalId as number;
		return;
	}
	doc.imdbId = args.externalId as string;
}

function setPatchIfChanged<TPatch extends Record<string, unknown>, K extends keyof TPatch>(
	patch: TPatch,
	key: K,
	currentValue: unknown,
	incomingValue: TPatch[K]
): void {
	if (!Object.is(currentValue, incomingValue)) {
		patch[key] = incomingValue;
	}
}

function setPatchByPolicy<
	TPatch extends Record<string, unknown>,
	K extends keyof TPatch,
	Current,
	Incoming
>(
	patch: TPatch,
	key: K,
	policy: SyncPolicy,
	currentValue: Current,
	incomingValue: Incoming,
	options?: { treatUnknownAsMissing?: boolean }
): void {
	if (shouldApplySyncPolicy(policy, currentValue, incomingValue, options)) {
		patch[key] = incomingValue as TPatch[K];
	}
}

export function buildMovieInsertDoc(
	args: InsertMediaArgs,
	incomingCreatorCredits: HeaderContributorInput[]
): MovieInsertDoc {
	const doc: MovieInsertDoc = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: args.backdropPath,
		releaseDate: args.releaseDate,
		detailSchemaVersion: args.detailSchemaVersion,
		detailFetchedAt: args.detailFetchedAt,
		nextRefreshAt: args.nextRefreshAt,
		refreshErrorCount: 0,
		lastRefreshErrorAt: null,
		isAnime: args.isAnime,
		director: args.director,
		creatorCredits: incomingCreatorCredits,
		overview: args.overview,
		status: args.status,
		runtime: args.runtime
	};
	assignSourceIdentifier(doc, args);
	return doc;
}

export function buildTVInsertDoc(
	args: InsertMediaArgs,
	incomingCreatorCredits: HeaderContributorInput[]
): TVInsertDoc {
	const doc: TVInsertDoc = {
		title: args.title,
		posterPath: args.posterPath,
		backdropPath: args.backdropPath,
		releaseDate: args.releaseDate,
		detailSchemaVersion: args.detailSchemaVersion,
		detailFetchedAt: args.detailFetchedAt,
		nextRefreshAt: args.nextRefreshAt,
		refreshErrorCount: 0,
		lastRefreshErrorAt: null,
		isAnime: args.isAnime,
		creator: args.creator,
		creatorCredits: incomingCreatorCredits,
		overview: args.overview,
		status: args.status,
		numberOfSeasons: args.numberOfSeasons,
		lastAirDate: args.lastAirDate,
		lastEpisodeToAir: args.lastEpisodeToAir,
		nextEpisodeToAir: args.nextEpisodeToAir
	};
	assignSourceIdentifier(doc, args);
	return doc;
}

export function buildMoviePatch(
	existing: StoredMovieDoc,
	args: InsertMediaArgs,
	incomingCreatorCredits: HeaderContributorInput[],
	syncPolicy: MovieSyncPolicyMap
): MoviePatch {
	const patch: MoviePatch = {};

	setPatchByPolicy(patch, 'title', syncPolicy.title, existing.title, args.title);
	setPatchByPolicy(patch, 'posterPath', syncPolicy.posterPath, existing.posterPath, args.posterPath);
	setPatchByPolicy(
		patch,
		'backdropPath',
		syncPolicy.backdropPath,
		existing.backdropPath,
		args.backdropPath
	);
	setPatchByPolicy(
		patch,
		'releaseDate',
		syncPolicy.releaseDate,
		existing.releaseDate,
		args.releaseDate
	);

	setPatchIfChanged(
		patch,
		'detailSchemaVersion',
		existing.detailSchemaVersion ?? 0,
		args.detailSchemaVersion
	);
	setPatchIfChanged(patch, 'detailFetchedAt', existing.detailFetchedAt ?? 0, args.detailFetchedAt);
	setPatchIfChanged(patch, 'nextRefreshAt', existing.nextRefreshAt ?? 0, args.nextRefreshAt);

	if ((existing.refreshErrorCount ?? 0) !== 0) {
		patch.refreshErrorCount = 0;
	}
	if (existing.lastRefreshErrorAt === undefined) {
		patch.lastRefreshErrorAt = null;
	}

	setPatchByPolicy(patch, 'overview', syncPolicy.overview, existing.overview, args.overview);
	setPatchByPolicy(patch, 'status', syncPolicy.status, existing.status ?? '', args.status);
	setPatchByPolicy(patch, 'runtime', syncPolicy.runtime, existing.runtime ?? null, args.runtime);
	setPatchByPolicy(patch, 'isAnime', syncPolicy.isAnime, existing.isAnime, args.isAnime);
	setPatchByPolicy(patch, 'director', syncPolicy.director, existing.director, args.director, {
		treatUnknownAsMissing: true
	});

	if (
		shouldApplySyncPolicy(
			syncPolicy.creatorCredits,
			existing.creatorCredits ?? [],
			incomingCreatorCredits
		) &&
		!sameHeaderContributors(existing.creatorCredits ?? [], incomingCreatorCredits)
	) {
		patch.creatorCredits = incomingCreatorCredits;
	}

	return patch;
}

export function buildTVPatch(
	existing: StoredTVDoc,
	args: InsertMediaArgs,
	incomingCreatorCredits: HeaderContributorInput[],
	syncPolicy: TVSyncPolicyMap
): TVPatch {
	const patch: TVPatch = {};

	setPatchByPolicy(patch, 'title', syncPolicy.title, existing.title, args.title);
	setPatchByPolicy(patch, 'posterPath', syncPolicy.posterPath, existing.posterPath, args.posterPath);
	setPatchByPolicy(
		patch,
		'backdropPath',
		syncPolicy.backdropPath,
		existing.backdropPath,
		args.backdropPath
	);
	setPatchByPolicy(
		patch,
		'releaseDate',
		syncPolicy.releaseDate,
		existing.releaseDate,
		args.releaseDate
	);

	setPatchIfChanged(
		patch,
		'detailSchemaVersion',
		existing.detailSchemaVersion ?? 0,
		args.detailSchemaVersion
	);
	setPatchIfChanged(patch, 'detailFetchedAt', existing.detailFetchedAt ?? 0, args.detailFetchedAt);
	setPatchIfChanged(patch, 'nextRefreshAt', existing.nextRefreshAt ?? 0, args.nextRefreshAt);

	if ((existing.refreshErrorCount ?? 0) !== 0) {
		patch.refreshErrorCount = 0;
	}
	if (existing.lastRefreshErrorAt === undefined) {
		patch.lastRefreshErrorAt = null;
	}

	setPatchByPolicy(patch, 'overview', syncPolicy.overview, existing.overview, args.overview);
	setPatchByPolicy(patch, 'status', syncPolicy.status, existing.status ?? '', args.status);
	setPatchByPolicy(
		patch,
		'numberOfSeasons',
		syncPolicy.numberOfSeasons,
		existing.numberOfSeasons,
		args.numberOfSeasons
	);
	setPatchByPolicy(patch, 'lastAirDate', syncPolicy.lastAirDate, existing.lastAirDate, args.lastAirDate);

	if (
		shouldApplySyncPolicy(
			syncPolicy.lastEpisodeToAir,
			existing.lastEpisodeToAir,
			args.lastEpisodeToAir
		) &&
		!sameEpisodeSummary(existing.lastEpisodeToAir, args.lastEpisodeToAir)
	) {
		patch.lastEpisodeToAir = args.lastEpisodeToAir;
	}
	if (
		shouldApplySyncPolicy(
			syncPolicy.nextEpisodeToAir,
			existing.nextEpisodeToAir,
			args.nextEpisodeToAir
		) &&
		!sameEpisodeSummary(existing.nextEpisodeToAir, args.nextEpisodeToAir)
	) {
		patch.nextEpisodeToAir = args.nextEpisodeToAir;
	}

	setPatchByPolicy(patch, 'isAnime', syncPolicy.isAnime, existing.isAnime, args.isAnime);
	setPatchByPolicy(patch, 'creator', syncPolicy.creator, existing.creator, args.creator, {
		treatUnknownAsMissing: true
	});

	if (
		shouldApplySyncPolicy(
			syncPolicy.creatorCredits,
			existing.creatorCredits ?? [],
			incomingCreatorCredits
		) &&
		!sameHeaderContributors(existing.creatorCredits ?? [], incomingCreatorCredits)
	) {
		patch.creatorCredits = incomingCreatorCredits;
	}

	return patch;
}
