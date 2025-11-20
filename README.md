# FrameRate

A modern, full-stack social platform for movie and TV enthusiasts. Track your viewing history, rate content, create curated collections, and discover trending media with a polished, responsive interface.

Try the Demo [here](https://frame-rate.io)



| | | |
|:-------------------------:|:-------------------------:|:-------------------------:|
|<img width="1132" height="810" alt="landing" src="https://github.com/user-attachments/assets/91c0f26b-1242-4263-813e-34217ed18d58" /><br/>Landing Page|<img width="1100" height="812" alt="home" src="https://github.com/user-attachments/assets/a117e1cb-5426-43a6-9996-66e9b28f941e" /><br/>Home Page|<img width="1093" height="815" alt="collection" src="https://github.com/user-attachments/assets/f0b98826-9b73-4be8-9b6a-a960993ce0a0" /><br/>Collection Page|
|<img width="1104" height="815" alt="library" src="https://github.com/user-attachments/assets/0f7f03fd-4197-41a8-8aa4-c3edd94faf5c" /><br/>Library Page|<img width="1212" height="812" alt="detail" src="https://github.com/user-attachments/assets/61ddad1e-7679-4afa-b9a8-5946c3f74684" /><br/>Details Page|<img width="1230" height="814" alt="search" src="https://github.com/user-attachments/assets/8e0b7f62-80a5-47f4-855e-f5e14e463274" /><br/>Search Modal|



## Overview

FrameRate is a social media application that allows users to:
- **Track & Rate** movies and TV shows with a 5-star rating system
- **Discover Content** through trending movies and shows
- **Explore Media** with detail pages featuring media summaries and community ratings
- **Curate Collections** with custom lists
- **Social Features** including liking and saving other users' public collections

## Key Features
- **Personal Library**: Comprehensive viewing history with ratings and watched status
- **Custom Ratings**: 5-star rating system with community averages
- **CRUD Operations**: Full create, read, update, delete support for personal lists
- **Trending Media and Search**: Powered by The Movie Database (TMDB) API
- **Responsive Design**: Adaptive UI for various devices
- **Optimistic Updates**: Instant UI feedback with debounced mutations
- **Smart Caching**: TanStack Query for intelligent data synchronization

## Tech Stack

FrameRate is built using modern web technologies including TypeScript, Svelte, TanStack Query, and more.

### Frontend
- **Framework**: [SvelteKit](https://kit.svelte.dev/) for performant reactivity and client-side routing
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) for consistent styles and naming conventions
- **UI Components**: [bits-ui](https://www.bits-ui.com/) for composable primitives
- **State Management**: [TanStack Query](https://tanstack.com/query) for server query caching
- **Form Handling**: [Sveltekit Superforms](https://superforms.rocks/) with Zod validation
- **Icons**: [Lucide Svelte](https://lucide.dev/)

### Backend Integration
- **API Client**: [Elysia Eden](https://elysiajs.com/eden/overview.html) for type-safe RPC
- **Authentication**: [Better Auth](https://www.better-auth.com/) with username plugin
- **Backend Framework**: [Elysia](https://elysiajs.com/) in a [separate repository](https://github.com/framerate-labs/framerate-server)

### External Services
- **Media Data**: [The Movie Database (TMDB)](https://www.themoviedb.org/) API

### Deployment & Infrastructure
- **Platform**: Cloudflare Workers
- **Package Manager**: Bun
- **Build Tool**: Vite 7

## Architecture Highlights

### Type-Safe API Integration
Uses Elysia's Eden Treaty for end-to-end type safety between frontend and backend:
```typescript
// Automatic route inference with full TypeScript support
const { data } = await client.api.v1.trending.index({
  time_window: 'week',
  media_type: 'movie'
}).get();
```

### Smart Data Fetching
TanStack Query handles all server state with intelligent caching:
- Stale-while-revalidate pattern for instant UI updates
- Query key-based invalidation for targeted cache updates
- Optimistic updates with automatic rollback on error

### Authentication Flow
- Better Auth with secure session cookies
- Reactive session state management
- Automatic token refresh

### Error Handling
- Custom `HttpError` class with status codes
- User-friendly error messages for common scenarios (401 auth, 429 rate limit)
- Toast notifications for all mutations
- Fallback UI for failed data loads

### Performance Optimizations
- Debounced mutations to prevent accidental double-submissions
- AbortSignal support for cancellable requests
- Optimistic UI updates for instant feedback
- Mobile drawers replace desktop modals for adaptive UX

## Technical Decisions

### Why Svelte over React (NextJS)?
- Cleaner client/server boundaries compared to client/server components in NextJS
- Smaller bundle sizes and faster load times, especially on mobile devices and slow networks
- Precise reactivity model only rerenders items that have changed
- Faster development compared to React due to templating language differences
- Avoids vendor lock-in as Svelte is easily deployable anywhere

### Why Cloudflare Workers?
- Global edge network for low-latency responses
- Serverless architecture with automatic scaling
- Cost-effective due to FrameRate's image-first nature

### Why TanStack Query?
- Best-in-class data synchronization and caching
- Automatic background refetching
- Optimistic updates with rollback
- DevTools for debugging

### Why Better Auth?
- Modern, TypeScript-first authentication library
- Flexible plugin system enables future auth expansion: OAuth, passkeys, email validation, and more
- No vendor lock-in
- Free to use

## Future Enhancements

- [ ] Mobile app (SwiftUI-based)
- [ ] User profiles with followers/following
- [ ] Activity feed showing friend reviews
- [ ] Advanced filtering and sorting in library
- [ ] Import from Letterboxd, IMDb, or other platforms
- [ ] Watchlist prioritization and recommendations
- [ ] User-generated reviews and comments
- [ ] OAuth integration (Apple, Google)
- [ ] Email notifications for updates

## Project Structure

```txt
src/
  routes/                  # SvelteKit file-based routing
    (auth)/                # Login, signup pages
    (details)/             # Media detail pages (films, series)
    [username]/            # Public user collection pages
    home/                  # Carousels with trending content
    library/               # Personal library (ratings)
    collections/           # Collections management
    api/                   # API endpoints (search proxy)

  lib/
    services/              # API client services (Elysia-Eden treaty)
    components/            # Svelte components
    types/                 # TypeScript definitions
    schema/                # Zod validation schemas
    stores/                # Svelte stores
    utils/                 # Helper functions
```

## License

MIT

---

**Note**: This project is a portfolio piece demonstrating full-stack development skills with modern web technologies. The backend API (Elysia server) is maintained in a separate repository.
