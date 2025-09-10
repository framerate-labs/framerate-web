export default function ListGridSkeleton() {
  return (
    <div className="grid w-full grid-cols-3 gap-2 md:grid-cols-4 lg:grid-cols-5 lg:gap-3.5">
      {Array.from({ length: 15 }).map((_, i) => (
        <div key={i} className="relative block rounded">
          <div className="h-[165px] w-[110px] animate-pulse rounded bg-white/[0.06] md:h-[225px] md:w-[150px] lg:h-[213px] lg:w-[143px] xl:h-[264px] xl:w-44" />
        </div>
      ))}
    </div>
  );
}
