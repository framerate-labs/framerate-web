import type {
	AniListCharacter,
	AniListCharacterVoiceActor,
	AniListDateParts,
	AniListMediaCore,
	AniListMediaRelation,
	AniListStaff,
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

function normalizeImageUrl(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	if (typeof row.large === 'string' && row.large.trim().length > 0) return row.large.trim();
	if (typeof row.medium === 'string' && row.medium.trim().length > 0) return row.medium.trim();
	return null;
}

function normalizeNamePart(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function normalizeAniListDisplayName(value: unknown): string {
	if (!value || typeof value !== 'object') return '';
	const row = value as Record<string, unknown>;
	const first = normalizeNamePart(row.first);
	const middle = normalizeNamePart(row.middle);
	const last = normalizeNamePart(row.last);
	const full = normalizeNamePart(row.full);
	if (last.length > 0 && (first.length > 0 || middle.length > 0)) {
		const ordered = [last, middle, first].filter((part) => part.length > 0).join(' ');
		if (ordered.length > 0) return ordered;
	}
	if (full.length > 0) return full;
	return '';
}

function normalizeVoiceActor(value: unknown): AniListCharacterVoiceActor | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const id = typeof row.id === 'number' ? row.id : null;
	const name = normalizeAniListDisplayName(row.name);
	if (id == null || name.length === 0) return null;
	return {
		anilistStaffId: id,
		name,
		imageUrl: normalizeImageUrl(row.image)
	};
}

function normalizeCharacters(value: unknown): AniListCharacter[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as Record<string, unknown>;
	const edges = Array.isArray(row.edges) ? row.edges : [];
	const characters: AniListCharacter[] = [];
	for (let index = 0; index < edges.length; index += 1) {
		const edge = edges[index];
		if (!edge || typeof edge !== 'object') continue;
		const edgeRow = edge as Record<string, unknown>;
		const node =
			edgeRow.node && typeof edgeRow.node === 'object'
				? (edgeRow.node as Record<string, unknown>)
				: null;
		if (!node) continue;
		const characterId = typeof node.id === 'number' ? node.id : null;
		const name = normalizeAniListDisplayName(node.name);
		if (characterId == null || name.length === 0) continue;
		const role = typeof edgeRow.role === 'string' ? edgeRow.role.trim() : '';
		const voiceActors = Array.isArray(edgeRow.voiceActors) ? edgeRow.voiceActors : [];
		const voiceActor = voiceActors
			.map(normalizeVoiceActor)
			.find((candidate): candidate is AniListCharacterVoiceActor => candidate != null);
		characters.push({
			anilistCharacterId: characterId,
			name,
			imageUrl: normalizeImageUrl(node.image),
			role: role.length > 0 ? role : null,
			voiceActor: voiceActor ?? null,
			order: index
		});
	}
	return characters;
}

function normalizeStaff(value: unknown): AniListStaff[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as Record<string, unknown>;
	const edges = Array.isArray(row.edges) ? row.edges : [];
	const staffRows: AniListStaff[] = [];
	for (let index = 0; index < edges.length; index += 1) {
		const edge = edges[index];
		if (!edge || typeof edge !== 'object') continue;
		const edgeRow = edge as Record<string, unknown>;
		const node =
			edgeRow.node && typeof edgeRow.node === 'object'
				? (edgeRow.node as Record<string, unknown>)
				: null;
		if (!node) continue;
		const staffId = typeof node.id === 'number' ? node.id : null;
		const name = normalizeAniListDisplayName(node.name);
		if (staffId == null || name.length === 0) continue;
		const role = typeof edgeRow.role === 'string' ? edgeRow.role.trim() : '';
		const occupations = Array.isArray(node.primaryOccupations) ? node.primaryOccupations : [];
		const department = occupations
			.map((value) => (typeof value === 'string' ? value.trim() : ''))
			.find((value) => value.length > 0);
		staffRows.push({
			anilistStaffId: staffId,
			name,
			imageUrl: normalizeImageUrl(node.image),
			role: role.length > 0 ? role : null,
			department: department ?? null,
			order: index
		});
	}
	return staffRows;
}

function normalizeRelations(value: unknown): AniListMediaRelation[] {
	if (!value || typeof value !== 'object') return [];
	const row = value as Record<string, unknown>;
	const edges = Array.isArray(row.edges) ? row.edges : [];
	const relations: AniListMediaRelation[] = [];
	for (const edge of edges) {
		if (!edge || typeof edge !== 'object') continue;
		const edgeRow = edge as Record<string, unknown>;
		const node = edgeRow.node;
		if (!node || typeof node !== 'object') continue;
		const nodeRow = node as Record<string, unknown>;
		const anilistId = typeof nodeRow.id === 'number' ? nodeRow.id : null;
		if (anilistId == null) continue;
		const titleRaw =
			nodeRow.title && typeof nodeRow.title === 'object'
				? (nodeRow.title as Record<string, unknown>)
				: {};
		relations.push({
			anilistId,
			relationType:
				typeof edgeRow.relationType === 'string' && edgeRow.relationType.trim().length > 0
					? edgeRow.relationType.trim()
					: 'OTHER',
			type: typeof nodeRow.type === 'string' ? nodeRow.type : null,
			title: {
				romaji: typeof titleRaw.romaji === 'string' ? titleRaw.romaji : null,
				english: typeof titleRaw.english === 'string' ? titleRaw.english : null,
				native: typeof titleRaw.native === 'string' ? titleRaw.native : null
			},
			format: typeof nodeRow.format === 'string' ? nodeRow.format : null,
			status: typeof nodeRow.status === 'string' ? nodeRow.status : null,
			startDate: toAniListDateParts(nodeRow.startDate),
			seasonYear: typeof nodeRow.seasonYear === 'number' ? nodeRow.seasonYear : null,
			episodes: typeof nodeRow.episodes === 'number' ? nodeRow.episodes : null
		});
	}
	return relations;
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
		studios: normalizeStudios(row.studios),
		characters: normalizeCharacters(row.characters),
		staff: normalizeStaff(row.staff),
		relations: normalizeRelations(row.relations)
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
