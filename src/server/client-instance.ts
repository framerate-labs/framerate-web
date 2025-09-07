import type { App } from '@framerate/server';

import { treaty } from '@elysiajs/eden';

function resolveServerUrl() {
  const isDev = import.meta.env.DEV;
  const devUrl = import.meta.env.VITE_SERVER_DEV_URL as string | undefined;
  const prodUrl = import.meta.env.VITE_SERVER_URL as string | undefined;

  // In production, require an explicit prod URL and validate it.
  if (!isDev) {
    if (!prodUrl) {
      throw new Error('[server] VITE_SERVER_URL is required in production.');
    }
    try {
      const url = new URL(prodUrl);
      if (url.protocol !== 'https:') {
        console.warn('[server] Non-HTTPS API URL detected in production:', url.origin);
      }
      return url.origin;
    } catch {
      throw new Error('[server] Invalid VITE_SERVER_URL. Provide a valid absolute URL.');
    }
  }

  // Development: prefer DEV URL, then fallback.
  if (devUrl) {
    try {
      return new URL(devUrl).origin;
    } catch {
      console.warn('[server] Invalid VITE_SERVER_DEV_URL. Falling back order: VITE_SERVER_URL -> http://localhost:8000');
    }
  }

  if (prodUrl) {
    // Loud warning: using production API during development.
    console.warn('\n============================================================');
    console.warn('[server] WARNING: Using VITE_SERVER_URL while in development.');
    console.warn('         You may be hitting the production API instead of local dev.');
    console.warn('         Set VITE_SERVER_DEV_URL to your local server to test changes.');
    console.warn('         Current target:', prodUrl);
    console.warn('============================================================\n');
    try {
      return new URL(prodUrl).origin;
    } catch {
      console.warn('[server] Invalid VITE_SERVER_URL in development fallback. Using http://localhost:8000');
    }
  }

  console.warn('[server] No server URL provided. Defaulting to http://localhost:8000');
  return 'http://localhost:8000';
}

const serverUrl = resolveServerUrl();

export const client = treaty<App>(serverUrl, {
  fetch: {
    // Required for cookie-based auth (SameSite=None + Secure in prod)
    credentials: 'include',
    // Keep requests predictable and secure in the browser
    mode: 'cors',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
  },
});
