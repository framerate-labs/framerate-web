export default function LibraryGridSkeleton() {
  return (
    <section className="mt-4 pb-20">
      <div className="bg-background-dark min-h-screen w-full rounded-md p-3 md:px-7 md:py-8">
        <div className="grid grid-cols-3 gap-2 md:grid-cols-4 md:gap-3 lg:grid-cols-6">
          {Array.from({ length: 24 }).map((_, i) => (
            <div
              key={i}
              className="h-[165px] w-[110px] animate-pulse rounded bg-white/[0.06] md:h-[225px] md:w-[150px] lg:h-[213px] lg:w-[143px] xl:h-[264px] xl:w-44"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
