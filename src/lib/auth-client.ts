import { usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

function resolveBaseUrl() {
  const isDev = import.meta.env.DEV;
  const devUrl = import.meta.env.VITE_SERVER_DEV_URL as string | undefined;
  const prodUrl = import.meta.env.VITE_SERVER_URL as string | undefined;

  if (!isDev) {
    if (!prodUrl) throw new Error('[auth] VITE_SERVER_URL is required in production.');
    try {
      const url = new URL(prodUrl);
      if (url.protocol !== 'https:') {
        console.warn('[auth] Non-HTTPS API URL detected in production:', url.origin);
      }
      return url.origin;
    } catch {
      throw new Error('[auth] Invalid VITE_SERVER_URL. Provide a valid absolute URL.');
    }
  }

  if (devUrl) {
    try {
      return new URL(devUrl).origin;
    } catch {
      console.warn('[auth] Invalid VITE_SERVER_DEV_URL. Falling back to VITE_SERVER_URL or localhost');
    }
  }

  if (prodUrl) {
    console.warn('\n============================================================');
    console.warn('[auth] WARNING: Using VITE_SERVER_URL while in development.');
    console.warn('       You may be hitting the production API instead of local dev.');
    console.warn('       Set VITE_SERVER_DEV_URL to your local server to test changes.');
    console.warn('       Current target:', prodUrl);
    console.warn('============================================================\n');
    try {
      return new URL(prodUrl).origin;
    } catch {
      console.warn('[auth] Invalid VITE_SERVER_URL in development. Using http://localhost:8000');
    }
  }

  console.warn('[auth] No server URL provided. Defaulting to http://localhost:8000');
  return 'http://localhost:8000';
}

export const authClient = createAuthClient({
  baseURL: resolveBaseUrl(),
  plugins: [usernameClient()],
});
