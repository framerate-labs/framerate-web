export type EpisodePoint = { tmdbSeasonNumber: number; tmdbEpisodeNumber: number };

export function compareEpisodePoint(a: EpisodePoint, b: EpisodePoint): number {
	if (a.tmdbSeasonNumber !== b.tmdbSeasonNumber) return a.tmdbSeasonNumber - b.tmdbSeasonNumber;
	return a.tmdbEpisodeNumber - b.tmdbEpisodeNumber;
}

function sourceCoversEpisodePoint(
	source: {
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
	},
	point: EpisodePoint
): boolean {
	if (source.tmdbSeasonNumber !== point.tmdbSeasonNumber) return false;
	const start = source.tmdbEpisodeStart ?? 1;
	const end = source.tmdbEpisodeEnd ?? Number.POSITIVE_INFINITY;
	return point.tmdbEpisodeNumber >= start && point.tmdbEpisodeNumber <= end;
}

export function anySourceCoversEpisodePoint(
	sources: Array<{
		tmdbSeasonNumber: number;
		tmdbEpisodeStart: number | null;
		tmdbEpisodeEnd: number | null;
	}>,
	point: EpisodePoint
): boolean {
	for (const source of sources) {
		if (sourceCoversEpisodePoint(source, point)) return true;
	}
	return false;
}

export function episodePointFromTVEpisode(
	episode: { seasonNumber?: number | null; episodeNumber?: number | null } | null | undefined
): EpisodePoint | null {
	const tmdbSeasonNumber = episode?.seasonNumber ?? null;
	const tmdbEpisodeNumber = episode?.episodeNumber ?? null;
	if (
		tmdbSeasonNumber == null ||
		tmdbEpisodeNumber == null ||
		!Number.isFinite(tmdbSeasonNumber) ||
		!Number.isFinite(tmdbEpisodeNumber)
	) {
		return null;
	}
	return { tmdbSeasonNumber, tmdbEpisodeNumber };
}
