import { useEffect, useRef, useState } from 'react';

type BackdropProps = {
  collection?: boolean;
  alt: string;
  backdropPath: string;
};

export default function Backdrop({
  alt,
  backdropPath,
  collection = false,
}: BackdropProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  function handleImageLoad() {
    setImageLoaded(true);
  }

  // Cached images will be complete
  useEffect(() => {
    if (imageRef.current && imageRef.current.complete) {
      setImageLoaded(true);
    }

    // Fallback timer for any edge cases
    const timer = setTimeout(() => {
      setImageLoaded(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  return (
    backdropPath && (
      <div className={`relative -z-10 m-auto h-auto w-full overflow-hidden`}>
        <img
          ref={imageRef}
          src={`https://image.tmdb.org/t/p/original${backdropPath}`}
          sizes="100vw"
          alt={alt}
          loading="lazy"
          decoding="async"
          fetchPriority="auto"
          width={1920}
          height={1080}
          onLoad={handleImageLoad}
          className={`${imageLoaded ? 'animate-fade-in' : 'opacity-0'} ${collection ? 'h-[450px]' : 'h-auto'} w-full object-cover`}
        />
        {/* Tablet and Desktop shadow gradient */}
        <div
          className={`${collection ? 'h-[550px]' : 'md:h-[455px] lg:h-[675px] xl:h-[700px]'} backdrop-fade pointer-events-none absolute top-0 hidden w-full bg-no-repeat md:block`}
        />
        {/* Mobile shadow gradient */}
        <div className="pointer-events-none absolute top-0 block size-full bg-gradient-to-t from-neutral-900 via-transparent to-transparent bg-no-repeat md:hidden" />
      </div>
    )
  );
}
