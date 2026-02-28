import type {
	AniListDateParts,
	AniListMediaCore,
	AniListStudio,
	AniListTitleSet
} from '../../types/animeTypes';

function toAniListDateParts(value: unknown): AniListDateParts | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	return {
		year: typeof row.year === 'number' ? row.year : null,
		month: typeof row.month === 'number' ? row.month : null,
		day: typeof row.day === 'number' ? row.day : null
	};
}

function normalizeStudios(value: unknown): AniListStudio[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as Record<string, unknown>;
	const nodes = Array.isArray(row.nodes) ? row.nodes : [];
	const edges = Array.isArray(row.edges) ? row.edges : [];
	const studios: AniListStudio[] = [];

	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!node || typeof node !== 'object') continue;
		const studio = node as Record<string, unknown>;
		const id = typeof studio.id === 'number' ? studio.id : null;
		const name = typeof studio.name === 'string' ? studio.name.trim() : '';
		if (id === null || name.length === 0) continue;

		const edge =
			index < edges.length && edges[index] && typeof edges[index] === 'object'
				? (edges[index] as Record<string, unknown>)
				: null;
		studios.push({
			anilistStudioId: id,
			name,
			isAnimationStudio:
				typeof studio.isAnimationStudio === 'boolean' ? studio.isAnimationStudio : undefined,
			isMain: edge && typeof edge.isMain === 'boolean' ? edge.isMain : undefined
		});
	}

	return studios;
}

export function normalizeMediaCore(value: unknown): AniListMediaCore | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const id = typeof row.id === 'number' ? row.id : null;
	if (id === null) return null;

	const titleRaw =
		row.title && typeof row.title === 'object' ? (row.title as Record<string, unknown>) : {};
	return {
		id,
		type: typeof row.type === 'string' ? row.type : null,
		title: {
			romaji: typeof titleRaw.romaji === 'string' ? titleRaw.romaji : null,
			english: typeof titleRaw.english === 'string' ? titleRaw.english : null,
			native: typeof titleRaw.native === 'string' ? titleRaw.native : null
		},
		format: typeof row.format === 'string' ? row.format : null,
		status: typeof row.status === 'string' ? row.status : null,
		startDate: toAniListDateParts(row.startDate),
		endDate: toAniListDateParts(row.endDate),
		seasonYear: typeof row.seasonYear === 'number' ? row.seasonYear : null,
		episodes: typeof row.episodes === 'number' ? row.episodes : null,
		description: typeof row.description === 'string' ? row.description : null,
		studios: normalizeStudios(row.studios)
	};
}

export function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\b(season|part|cour)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function titleVariants(title: AniListTitleSet): string[] {
	return [title.romaji, title.english, title.native].filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0
	);
}

export function tokenize(value: string): Set<string> {
	return new Set(
		normalizeText(value)
			.split(' ')
			.map((token) => token.trim())
			.filter((token) => token.length > 0)
	);
}

export function extractTitleYears(value: string): number[] {
	const matches = value.match(/\b(19|20)\d{2}\b/g);
	if (!matches) return [];
	return matches
		.map((token) => Number(token))
		.filter((year) => Number.isFinite(year) && year >= 1900 && year <= 2100);
}

export function normalizedStudioName(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
