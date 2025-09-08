import { Link } from '@tanstack/react-router';

export function NotFound() {
  return (
    <div className="text-foreground flex min-h-[60vh] w-full flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
          404 — Scene Missing
        </h1>
        <p className="text-gray text-sm">
          Looks like this page left to get popcorn. Try the homepage while the
          credits roll.
        </p>
      </div>

      <Link
        to="/home"
        className="bg-background text-foreground ring-border hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold ring-1 transition-colors"
      >
        Take me home
      </Link>
    </div>
  );
}
