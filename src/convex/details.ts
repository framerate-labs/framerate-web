import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { MediaType, NormalizedMediaDetails } from './services/detailsService';
import type { MediaSource } from './lib/mediaLookup';

import { v } from 'convex/values';

import { internal } from './_generated/api';
import { action, internalMutation, internalQuery } from './_generated/server';
import { fetchDetailsFromTMDB } from './services/detailsService';
import { getMovieBySource, getTVShowBySource } from './lib/mediaLookup';

// Argument validators
const mediaTypeValidator = v.union(v.literal('movie'), v.literal('tv'));
const sourceValidator = v.union(v.literal('tmdb'), v.literal('trakt'), v.literal('imdb'));
const MEDIA_METADATA_VERSION = 1;

const enrichmentPersonValidator = v.object({
	tmdbId: v.number(),
	name: v.string(),
	originalName: v.union(v.string(), v.null()),
	profilePath: v.union(v.string(), v.null()),
	knownForDepartment: v.union(v.string(), v.null()),
	role: v.string(),
	department: v.union(v.string(), v.null()),
	job: v.union(v.string(), v.null()),
	character: v.union(v.string(), v.null()),
	creditId: v.string(),
	billingOrder: v.number()
});

const enrichmentCompanyValidator = v.object({
	tmdbId: v.number(),
	name: v.string(),
	logoPath: v.union(v.string(), v.null()),
	originCountry: v.union(v.string(), v.null()),
	role: v.string(),
	billingOrder: v.number()
});

type EnrichmentPersonInput = {
	tmdbId: number;
	name: string;
	originalName: string | null;
	profilePath: string | null;
	knownForDepartment: string | null;
	role: string;
	department: string | null;
	job: string | null;
	character: string | null;
	creditId: string;
	billingOrder: number;
};

type EnrichmentCompanyInput = {
	tmdbId: number;
	name: string;
	logoPath: string | null;
	originCountry: string | null;
	role: string;
	billingOrder: number;
};

type PrimaryStudio = {
	tmdbId: number;
	name: string;
};

function computeIsAnime(details: NormalizedMediaDetails): boolean {
	const hasAnimationGenre = details.genres.some(
		(genre) => genre.id === 16 || genre.name.toLowerCase() === 'animation'
	);
	const hasJapaneseLanguage =
		details.originalLanguage === 'ja' ||
		details.spokenLanguages.some((language) => language.iso6391 === 'ja') ||
		(details.mediaType === 'tv' && details.languages.includes('ja'));
	const hasJapaneseOrigin =
		details.originCountry.includes('JP') ||
		details.productionCountries.some((country) => country.iso31661 === 'JP');

	const score = [hasAnimationGenre, hasJapaneseLanguage, hasJapaneseOrigin].filter(Boolean).length;
	return score >= 2;
}

function dedupeCompanies(companies: EnrichmentCompanyInput[]): EnrichmentCompanyInput[] {
	const seen = new Set<number>();
	const unique: EnrichmentCompanyInput[] = [];
	for (const company of companies) {
		if (seen.has(company.tmdbId)) continue;
		seen.add(company.tmdbId);
		unique.push(company);
	}
	return unique;
}

function pickPrimaryStudio(
	companies: EnrichmentCompanyInput[],
	isAnime: boolean
): PrimaryStudio | null {
	if (companies.length === 0) return null;

	if (isAnime) {
		const japanese = companies.find((company) => company.originCountry === 'JP');
		if (japanese) {
			return { tmdbId: japanese.tmdbId, name: japanese.name };
		}
	}

	const first = companies[0];
	if (!first) return null;
	return { tmdbId: first.tmdbId, name: first.name };
}

function buildPeople(details: NormalizedMediaDetails): EnrichmentPersonInput[] {
	if (details.mediaType === 'movie') {
		return details.directorList.map((director, index) => ({
			tmdbId: director.id,
			name: director.name,
			originalName: director.originalName,
			profilePath: director.profilePath,
			knownForDepartment: director.knownForDepartment,
			role: 'director',
			department: director.department,
			job: director.job,
			character: null,
			creditId:
				director.creditId.trim() !== ''
					? director.creditId
					: `director-${director.id}-${index}`,
			billingOrder: index
		}));
	}

	return details.creatorList.map((creator, index) => ({
		tmdbId: creator.id,
		name: creator.name,
		originalName: creator.originalName,
		profilePath: creator.profilePath,
		knownForDepartment: null,
		role: 'creator',
		department: null,
		job: 'Creator',
		character: null,
		creditId: creator.creditId.trim() !== '' ? creator.creditId : `creator-${creator.id}-${index}`,
		billingOrder: index
	}));
}

function buildCompanies(details: NormalizedMediaDetails): EnrichmentCompanyInput[] {
	return dedupeCompanies(
		details.productionCompanies.map((company, index) => ({
			tmdbId: company.id,
			name: company.name,
			logoPath: company.logoPath,
			originCountry: company.originCountry.trim() === '' ? null : company.originCountry,
			role: 'production',
			billingOrder: index
		}))
	);
}

async function upsertPerson(ctx: MutationCtx, person: EnrichmentPersonInput): Promise<Id<'people'>> {
	const existing = await ctx.db
		.query('people')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', person.tmdbId))
		.unique();

	if (!existing) {
		return await ctx.db.insert('people', {
			tmdbId: person.tmdbId,
			name: person.name,
			originalName: person.originalName ?? undefined,
			profilePath: person.profilePath,
			knownForDepartment: person.knownForDepartment
		});
	}

	const patch: {
		name?: string;
		originalName?: string;
		profilePath?: string | null;
		knownForDepartment?: string | null;
	} = {};

	if (existing.name !== person.name) {
		patch.name = person.name;
	}
	if ((existing.originalName ?? undefined) !== (person.originalName ?? undefined)) {
		patch.originalName = person.originalName ?? undefined;
	}
	if (existing.profilePath !== person.profilePath) {
		patch.profilePath = person.profilePath;
	}
	if (existing.knownForDepartment !== person.knownForDepartment) {
		patch.knownForDepartment = person.knownForDepartment;
	}

	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}

	return existing._id;
}

async function upsertCompany(
	ctx: MutationCtx,
	company: EnrichmentCompanyInput
): Promise<Id<'companies'>> {
	const existing = await ctx.db
		.query('companies')
		.withIndex('by_tmdbId', (q) => q.eq('tmdbId', company.tmdbId))
		.unique();

	if (!existing) {
		return await ctx.db.insert('companies', {
			tmdbId: company.tmdbId,
			name: company.name,
			logoPath: company.logoPath,
			originCountry: company.originCountry
		});
	}

	const patch: {
		name?: string;
		logoPath?: string | null;
		originCountry?: string | null;
	} = {};

	if (existing.name !== company.name) {
		patch.name = company.name;
	}
	if (existing.logoPath !== company.logoPath) {
		patch.logoPath = company.logoPath;
	}
	if (existing.originCountry !== company.originCountry) {
		patch.originCountry = company.originCountry;
	}

	if (Object.keys(patch).length > 0) {
		await ctx.db.patch(existing._id, patch);
	}

	return existing._id;
}

async function syncMovieCredits(
	ctx: MutationCtx,
	movieId: Id<'movies'>,
	people: EnrichmentPersonInput[]
): Promise<void> {
	const role = 'director';
	const incoming = people.filter((person) => person.role === role);
	const existing = await ctx.db
		.query('movieCredits')
		.withIndex('by_movieId_role', (q) => q.eq('movieId', movieId).eq('role', role))
		.collect();
	const existingByCreditId = new Map(existing.map((row) => [row.creditId, row]));
	const incomingCreditIds = new Set<string>();

	for (const person of incoming) {
		incomingCreditIds.add(person.creditId);
		const personId = await upsertPerson(ctx, person);
		const existingCredit = existingByCreditId.get(person.creditId);

		if (!existingCredit) {
			await ctx.db.insert('movieCredits', {
				movieId,
				personId,
				personTmdbId: person.tmdbId,
				role: person.role,
				department: person.department,
				job: person.job,
				character: person.character,
				creditId: person.creditId,
				billingOrder: person.billingOrder,
				source: 'tmdb'
			});
			continue;
		}

		const patch: {
			personId?: Id<'people'>;
			personTmdbId?: number;
			department?: string | null;
			job?: string | null;
			character?: string | null;
			billingOrder?: number;
		} = {};

		if (existingCredit.personId !== personId) {
			patch.personId = personId;
		}
		if (existingCredit.personTmdbId !== person.tmdbId) {
			patch.personTmdbId = person.tmdbId;
		}
		if (existingCredit.department !== person.department) {
			patch.department = person.department;
		}
		if (existingCredit.job !== person.job) {
			patch.job = person.job;
		}
		if (existingCredit.character !== person.character) {
			patch.character = person.character;
		}
		if (existingCredit.billingOrder !== person.billingOrder) {
			patch.billingOrder = person.billingOrder;
		}

		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existingCredit._id, patch);
		}
	}

	for (const stale of existing) {
		if (!incomingCreditIds.has(stale.creditId)) {
			await ctx.db.delete(stale._id);
		}
	}
}

async function syncTVCredits(
	ctx: MutationCtx,
	tvShowId: Id<'tvShows'>,
	people: EnrichmentPersonInput[]
): Promise<void> {
	const role = 'creator';
	const incoming = people.filter((person) => person.role === role);
	const existing = await ctx.db
		.query('tvCredits')
		.withIndex('by_tvShowId_role', (q) => q.eq('tvShowId', tvShowId).eq('role', role))
		.collect();
	const existingByCreditId = new Map(existing.map((row) => [row.creditId, row]));
	const incomingCreditIds = new Set<string>();

	for (const person of incoming) {
		incomingCreditIds.add(person.creditId);
		const personId = await upsertPerson(ctx, person);
		const existingCredit = existingByCreditId.get(person.creditId);

		if (!existingCredit) {
			await ctx.db.insert('tvCredits', {
				tvShowId,
				personId,
				personTmdbId: person.tmdbId,
				role: person.role,
				department: person.department,
				job: person.job,
				character: person.character,
				creditId: person.creditId,
				billingOrder: person.billingOrder,
				source: 'tmdb'
			});
			continue;
		}

		const patch: {
			personId?: Id<'people'>;
			personTmdbId?: number;
			department?: string | null;
			job?: string | null;
			character?: string | null;
			billingOrder?: number;
		} = {};

		if (existingCredit.personId !== personId) {
			patch.personId = personId;
		}
		if (existingCredit.personTmdbId !== person.tmdbId) {
			patch.personTmdbId = person.tmdbId;
		}
		if (existingCredit.department !== person.department) {
			patch.department = person.department;
		}
		if (existingCredit.job !== person.job) {
			patch.job = person.job;
		}
		if (existingCredit.character !== person.character) {
			patch.character = person.character;
		}
		if (existingCredit.billingOrder !== person.billingOrder) {
			patch.billingOrder = person.billingOrder;
		}

		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existingCredit._id, patch);
		}
	}

	for (const stale of existing) {
		if (!incomingCreditIds.has(stale.creditId)) {
			await ctx.db.delete(stale._id);
		}
	}
}

async function syncMovieCompanies(
	ctx: MutationCtx,
	movieId: Id<'movies'>,
	companies: EnrichmentCompanyInput[]
): Promise<void> {
	const existing = await ctx.db
		.query('movieCompanies')
		.withIndex('by_movieId', (q) => q.eq('movieId', movieId))
		.collect();
	const existingByTmdbId = new Map(existing.map((row) => [row.companyTmdbId, row]));
	const incomingTmdbIds = new Set<number>();

	for (const company of companies) {
		incomingTmdbIds.add(company.tmdbId);
		const companyId = await upsertCompany(ctx, company);
		const existingJoin = existingByTmdbId.get(company.tmdbId);

		if (!existingJoin) {
			await ctx.db.insert('movieCompanies', {
				movieId,
				companyId,
				companyTmdbId: company.tmdbId,
				role: company.role,
				billingOrder: company.billingOrder,
				source: 'tmdb'
			});
			continue;
		}

		const patch: {
			companyId?: Id<'companies'>;
			role?: string;
			billingOrder?: number;
		} = {};

		if (existingJoin.companyId !== companyId) {
			patch.companyId = companyId;
		}
		if (existingJoin.role !== company.role) {
			patch.role = company.role;
		}
		if (existingJoin.billingOrder !== company.billingOrder) {
			patch.billingOrder = company.billingOrder;
		}

		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existingJoin._id, patch);
		}
	}

	for (const stale of existing) {
		if (!incomingTmdbIds.has(stale.companyTmdbId)) {
			await ctx.db.delete(stale._id);
		}
	}
}

async function syncTVCompanies(
	ctx: MutationCtx,
	tvShowId: Id<'tvShows'>,
	companies: EnrichmentCompanyInput[]
): Promise<void> {
	const existing = await ctx.db
		.query('tvCompanies')
		.withIndex('by_tvShowId', (q) => q.eq('tvShowId', tvShowId))
		.collect();
	const existingByTmdbId = new Map(existing.map((row) => [row.companyTmdbId, row]));
	const incomingTmdbIds = new Set<number>();

	for (const company of companies) {
		incomingTmdbIds.add(company.tmdbId);
		const companyId = await upsertCompany(ctx, company);
		const existingJoin = existingByTmdbId.get(company.tmdbId);

		if (!existingJoin) {
			await ctx.db.insert('tvCompanies', {
				tvShowId,
				companyId,
				companyTmdbId: company.tmdbId,
				role: company.role,
				billingOrder: company.billingOrder,
				source: 'tmdb'
			});
			continue;
		}

		const patch: {
			companyId?: Id<'companies'>;
			role?: string;
			billingOrder?: number;
		} = {};

		if (existingJoin.companyId !== companyId) {
			patch.companyId = companyId;
		}
		if (existingJoin.role !== company.role) {
			patch.role = company.role;
		}
		if (existingJoin.billingOrder !== company.billingOrder) {
			patch.billingOrder = company.billingOrder;
		}

		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(existingJoin._id, patch);
		}
	}

	for (const stale of existing) {
		if (!incomingTmdbIds.has(stale.companyTmdbId)) {
			await ctx.db.delete(stale._id);
		}
	}
}

/**
 * Internal Query: Get stored media images and metadata sync version from DB.
 */
export const getStoredMedia = internalQuery({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string())
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const movie = await getMovieBySource(ctx, args.source as MediaSource, args.externalId);
			if (!movie) return null;
			return {
				posterPath: movie.posterPath,
				backdropPath: movie.backdropPath,
				metadataVersion: movie.metadataVersion ?? null
			};
		}

		const tvShow = await getTVShowBySource(ctx, args.source as MediaSource, args.externalId);
		if (!tvShow) return null;
		return {
			posterPath: tvShow.posterPath,
			backdropPath: tvShow.backdropPath,
			metadataVersion: tvShow.metadataVersion ?? null
		};
	}
});

/**
 * Internal Mutation: Upsert media data and synchronize people/company relations.
 */
export const insertMedia = internalMutation({
	args: {
		mediaType: mediaTypeValidator,
		source: sourceValidator,
		externalId: v.union(v.number(), v.string()),
		title: v.string(),
		posterPath: v.union(v.string(), v.null()),
		backdropPath: v.union(v.string(), v.null()),
		releaseDate: v.union(v.string(), v.null()),
		isAnime: v.boolean(),
		primaryStudioTmdbId: v.optional(v.number()),
		primaryStudioName: v.optional(v.string()),
		director: v.union(v.string(), v.null()),
		creator: v.union(v.string(), v.null()),
		people: v.array(enrichmentPersonValidator),
		companies: v.array(enrichmentCompanyValidator)
	},
	handler: async (ctx, args) => {
		if (args.mediaType === 'movie') {
			const existing = await getMovieBySource(ctx, args.source as MediaSource, args.externalId);
			let movieId: Id<'movies'>;

			if (!existing) {
				const movieData: {
					tmdbId?: number;
					traktId?: number;
					imdbId?: string;
					title: string;
					posterPath: string | null;
					backdropPath: string | null;
					releaseDate: string | null;
					slug: null;
					metadataVersion: number;
					isAnime: boolean;
					primaryStudioTmdbId?: number;
					primaryStudioName?: string;
					director?: string;
				} = {
					title: args.title,
					posterPath: args.posterPath,
					backdropPath: args.backdropPath,
					releaseDate: args.releaseDate,
					slug: null,
					metadataVersion: MEDIA_METADATA_VERSION,
					isAnime: args.isAnime,
					primaryStudioTmdbId: args.primaryStudioTmdbId,
					primaryStudioName: args.primaryStudioName,
					director: args.director ?? undefined
				};

				if (args.source === 'tmdb') {
					movieData.tmdbId = args.externalId as number;
				} else if (args.source === 'trakt') {
					movieData.traktId = args.externalId as number;
				} else {
					movieData.imdbId = args.externalId as string;
				}

				movieId = await ctx.db.insert('movies', movieData);
			} else {
				movieId = existing._id;
				const patch: {
					posterPath?: string | null;
					backdropPath?: string | null;
					releaseDate?: string | null;
					metadataVersion?: number;
					isAnime?: boolean;
					primaryStudioTmdbId?: number;
					primaryStudioName?: string;
					director?: string;
				} = {};

				if (existing.posterPath === null && args.posterPath !== null) {
					patch.posterPath = args.posterPath;
				}
				if (existing.backdropPath === null && args.backdropPath !== null) {
					patch.backdropPath = args.backdropPath;
				}
				if (existing.releaseDate === null && args.releaseDate !== null) {
					patch.releaseDate = args.releaseDate;
				}
				if ((existing.metadataVersion ?? 0) !== MEDIA_METADATA_VERSION) {
					patch.metadataVersion = MEDIA_METADATA_VERSION;
				}
				if (existing.isAnime === undefined) {
					patch.isAnime = args.isAnime;
				}
				if (
					(existing.primaryStudioTmdbId === undefined ||
						existing.primaryStudioTmdbId === null) &&
					args.primaryStudioTmdbId !== undefined
				) {
					patch.primaryStudioTmdbId = args.primaryStudioTmdbId;
				}
				if (
					(existing.primaryStudioName === undefined || existing.primaryStudioName === null) &&
					args.primaryStudioName !== undefined
				) {
					patch.primaryStudioName = args.primaryStudioName;
				}
				if (
					(existing.director === undefined ||
						existing.director === null ||
						existing.director === 'Unknown') &&
					args.director !== null
				) {
					patch.director = args.director;
				}

				if (Object.keys(patch).length > 0) {
					await ctx.db.patch(movieId, patch);
				}
			}

			await syncMovieCredits(ctx, movieId, args.people as EnrichmentPersonInput[]);
			await syncMovieCompanies(ctx, movieId, args.companies as EnrichmentCompanyInput[]);
			return;
		}

		const existing = await getTVShowBySource(ctx, args.source as MediaSource, args.externalId);
		let tvShowId: Id<'tvShows'>;

		if (!existing) {
			const tvShowData: {
				tmdbId?: number;
				traktId?: number;
				imdbId?: string;
				title: string;
				posterPath: string | null;
				backdropPath: string | null;
				releaseDate: string | null;
				slug: null;
				metadataVersion: number;
				isAnime: boolean;
				primaryStudioTmdbId?: number;
				primaryStudioName?: string;
				creator?: string;
			} = {
				title: args.title,
				posterPath: args.posterPath,
				backdropPath: args.backdropPath,
				releaseDate: args.releaseDate,
				slug: null,
				metadataVersion: MEDIA_METADATA_VERSION,
				isAnime: args.isAnime,
				primaryStudioTmdbId: args.primaryStudioTmdbId,
				primaryStudioName: args.primaryStudioName,
				creator: args.creator ?? undefined
			};

			if (args.source === 'tmdb') {
				tvShowData.tmdbId = args.externalId as number;
			} else if (args.source === 'trakt') {
				tvShowData.traktId = args.externalId as number;
			} else {
				tvShowData.imdbId = args.externalId as string;
			}

			tvShowId = await ctx.db.insert('tvShows', tvShowData);
		} else {
			tvShowId = existing._id;
			const patch: {
				posterPath?: string | null;
				backdropPath?: string | null;
				releaseDate?: string | null;
				metadataVersion?: number;
				isAnime?: boolean;
				primaryStudioTmdbId?: number;
				primaryStudioName?: string;
				creator?: string;
			} = {};

			if (existing.posterPath === null && args.posterPath !== null) {
				patch.posterPath = args.posterPath;
			}
			if (existing.backdropPath === null && args.backdropPath !== null) {
				patch.backdropPath = args.backdropPath;
			}
			if (existing.releaseDate === null && args.releaseDate !== null) {
				patch.releaseDate = args.releaseDate;
			}
			if ((existing.metadataVersion ?? 0) !== MEDIA_METADATA_VERSION) {
				patch.metadataVersion = MEDIA_METADATA_VERSION;
			}
			if (existing.isAnime === undefined) {
				patch.isAnime = args.isAnime;
			}
			if (
				(existing.primaryStudioTmdbId === undefined || existing.primaryStudioTmdbId === null) &&
				args.primaryStudioTmdbId !== undefined
			) {
				patch.primaryStudioTmdbId = args.primaryStudioTmdbId;
			}
			if (
				(existing.primaryStudioName === undefined || existing.primaryStudioName === null) &&
				args.primaryStudioName !== undefined
			) {
				patch.primaryStudioName = args.primaryStudioName;
			}
			if (
				(existing.creator === undefined || existing.creator === null || existing.creator === 'Unknown') &&
				args.creator !== null
			) {
				patch.creator = args.creator;
			}

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(tvShowId, patch);
			}
		}

		await syncTVCredits(ctx, tvShowId, args.people as EnrichmentPersonInput[]);
		await syncTVCompanies(ctx, tvShowId, args.companies as EnrichmentCompanyInput[]);
	}
});

/**
 * Action: Get media details from external source.
 */
export const get = action({
	args: {
		mediaType: mediaTypeValidator,
		id: v.union(v.number(), v.string()),
		source: v.optional(sourceValidator)
	},
	handler: async (ctx, args): Promise<NormalizedMediaDetails> => {
		const source = (args.source ?? 'tmdb') as MediaSource;

		if (source !== 'tmdb') {
			throw new Error(
				`Source '${source}' is not yet implemented. Currently only 'tmdb' is supported for details.`
			);
		}

		if (typeof args.id !== 'number') {
			throw new Error('TMDB IDs must be numbers');
		}

		const [storedMedia, details] = await Promise.all([
			ctx.runQuery(internal.details.getStoredMedia, {
				mediaType: args.mediaType as MediaType,
				source,
				externalId: args.id
			}),
			fetchDetailsFromTMDB(args.mediaType as MediaType, args.id)
		]);

		const companies = buildCompanies(details);
		const isAnime = computeIsAnime(details);
		const primaryStudio = pickPrimaryStudio(companies, isAnime);
		const people = buildPeople(details);
		const needsMetadataSync =
			storedMedia === null || (storedMedia.metadataVersion ?? 0) !== MEDIA_METADATA_VERSION;

		if (needsMetadataSync) {
			await ctx.runMutation(internal.details.insertMedia, {
				mediaType: args.mediaType as MediaType,
				source,
				externalId: args.id,
				title: details.title,
				posterPath: details.posterPath,
				backdropPath: details.backdropPath,
				releaseDate: details.releaseDate,
				isAnime,
				primaryStudioTmdbId: primaryStudio?.tmdbId,
				primaryStudioName: primaryStudio?.name,
				director: details.mediaType === 'movie' ? details.director : null,
				creator: details.mediaType === 'tv' ? details.creator : null,
				people,
				companies
			});
		}

		if (storedMedia) {
			return {
				...details,
				posterPath: storedMedia.posterPath ?? details.posterPath,
				backdropPath: storedMedia.backdropPath ?? details.backdropPath
			};
		}

		return details;
	}
});
