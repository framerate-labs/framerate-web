export default function PopularListCardSkeleton() {
  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02] animate-pulse">
      <div className="w-full h-36 sm:h-40 md:h-44 lg:h-48 xl:h-52 bg-white/[0.06]" />
      <div className="p-3 space-y-2">
        <div className="h-4 w-3/4 rounded bg-white/[0.06]" />
        <div className="h-3 w-1/3 rounded bg-white/[0.06]" />
      </div>
    </div>
  );
}

