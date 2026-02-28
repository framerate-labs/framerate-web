const ANILIST_MEDIA_FIELDS = `
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
query AnimeMediaByIdForEnrichment($id: Int!) {
  Media(id: $id, type: ANIME) {
    ${ANILIST_MEDIA_FIELDS}
  }
}
`;
