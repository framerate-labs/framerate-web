const ANILIST_MEDIA_BASE_FIELDS = `
  id
  type
  title { romaji english native }
  format
  status
  startDate { year month day }
  endDate { year month day }
  seasonYear
  episodes
  description(asHtml: false)
  studios {
    edges { isMain }
    nodes { id name isAnimationStudio }
  }
  relations {
    edges {
      relationType(version: 2)
      node {
        id
        type
        title { romaji english native }
        format
        status
        startDate { year month day }
        seasonYear
        episodes
      }
    }
  }
`;

const ANILIST_MEDIA_CONNECTION_FIELDS = `
  characters(page: $charactersPage, perPage: $perPage, sort: [ROLE, RELEVANCE, ID]) @include(if: $includeCharacters) {
    pageInfo {
      hasNextPage
    }
    edges {
      role
      node {
        id
        name { first middle last full }
        image { large medium }
      }
      voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) {
        id
        name { first middle last full }
        image { large medium }
      }
    }
  }
  staff(page: $staffPage, perPage: $perPage, sort: [RELEVANCE, ID]) @include(if: $includeStaff) {
    pageInfo {
      hasNextPage
    }
    edges {
      role
      node {
        id
        name { first middle last full }
        image { large medium }
        primaryOccupations
      }
    }
  }
`;

const ANILIST_SEARCH_FIELDS = `
  id
  type
  title { romaji english native }
  format
  status
  startDate { year month day }
  endDate { year month day }
  seasonYear
  episodes
  studios {
    edges { isMain }
    nodes { id name isAnimationStudio }
  }
`;

export const SEARCH_ANIME_QUERY = `
query SearchAnime($search: String!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: [POPULARITY_DESC]) {
      ${ANILIST_SEARCH_FIELDS}
    }
  }
}
`;

export const MEDIA_BY_ID_QUERY = `
query AnimeMediaByIdForEnrichment(
  $id: Int!
  $charactersPage: Int!
  $staffPage: Int!
  $perPage: Int!
  $includeCharacters: Boolean!
  $includeStaff: Boolean!
) {
  Media(id: $id, type: ANIME) {
    ${ANILIST_MEDIA_BASE_FIELDS}
    ${ANILIST_MEDIA_CONNECTION_FIELDS}
  }
}
`;
