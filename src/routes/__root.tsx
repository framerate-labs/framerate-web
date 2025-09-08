import { QueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouterState,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { Analytics } from '@vercel/analytics/react';
import { Toaster } from 'sonner';

import manropeFontUrl from '@/assets/fonts/manrope-variable.woff2?url';
import { DefaultCatchBoundary } from '@/components/default-catch-boundary';
import Navbar from '@/components/navbar';
import { NotFound } from '@/components/not-found';
import appCss from '@/styles/app.css?url';

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'FrameRate',
        description: `FrameRate is the ultimate social platform for movie and TV enthusiasts. Share your reviews, create and discover lists, and effortlessly track everything you've watched!`,
      },
    ],
    links: [
      ...(import.meta.env.PROD
        ? ([
            {
              rel: 'preload' as const,
              href: manropeFontUrl,
              as: 'font' as const,
              type: 'font/woff2',
              crossOrigin: 'anonymous' as const,
            },
          ] as const)
        : ([] as const)),
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  errorComponent: (props) => {
    return <DefaultCatchBoundary {...props} />;
  },
  notFoundComponent: () => {
    return <NotFound />;
  },
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        className={`${pathname === '/' ? 'bg-background-landing' : 'bg-background'} ${pathname.includes('film') || pathname.includes('series') ? 'p-0' : 'px-2 py-4'} font-manrope dark antialiased md:p-0`}
      >
        <div className="mx-auto size-full max-w-md md:max-w-2xl lg:max-w-6xl xl:max-w-[1200px]">
          {children}
          <Navbar />
          <Toaster
            toastOptions={{
              classNames: {
                toast:
                  'bg-background border-white/10 text-foreground drop-shadow-md',
              },
            }}
          />
          <Analytics />
          {import.meta.env.DEV && (
            <TanStackRouterDevtools position="bottom-right" />
          )}
          {import.meta.env.DEV && (
            <ReactQueryDevtools buttonPosition="bottom-left" />
          )}
          <Scripts />
        </div>
      </body>
    </html>
  );
}
