export default function SidebarSkeleton() {
  return (
    <nav className="animate-fade-in bg-background-dark sticky top-10 flex w-full grow flex-col gap-4 overflow-y-auto overflow-x-hidden rounded-lg px-3 py-5">
      <div className="mb-2 h-5 w-1/2 animate-pulse rounded bg-white/10" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="h-4 w-2/3 animate-pulse rounded bg-white/10" />
            <div className="h-8 w-1 rounded bg-white/10" />
          </div>
        ))}
      </div>
    </nav>
  );
}

