import { useEffect, useRef, useState } from 'react';

type PosterProps = {
  title: string;
  src: string | null;
  fetchSize: string;
  width: number;
  height: number;
  perspectiveEnabled: boolean;
  scale?: number;
  loading: 'eager' | 'lazy';
  sizes?: string;
  classes: string;
};

export default function Poster({
  title,
  fetchSize,
  src,
  width,
  height,
  perspectiveEnabled,
  scale,
  loading,
  sizes,
  classes,
}: PosterProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const boundingRef = useRef<DOMRect | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  let perspectiveClasses = '';
  if (perspectiveEnabled) {
    perspectiveClasses =
      'group rounded relative transform-gpu transition-transform ease-out hover:[transform:rotateX(var(--x-rotation))_rotateY(var(--y-rotation))]';
  }

  const handleMouseEnter = perspectiveEnabled
    ? (event: React.MouseEvent<HTMLDivElement>) => {
        boundingRef.current = event.currentTarget.getBoundingClientRect();
      }
    : undefined;
  const handleMouseLeave = perspectiveEnabled
    ? () => (boundingRef.current = null)
    : undefined;
  const handleMouseMove = perspectiveEnabled
    ? (event: React.MouseEvent<HTMLDivElement>) => {
        if (!boundingRef.current) return;
        const x = event.clientX - boundingRef.current.left;
        const y = event.clientY - boundingRef.current.top;
        const xPercentage = x / boundingRef.current.width;
        const yPercentage = y / boundingRef.current.height;
        // converts the positions into degrees
        // x needs to be subtracted from 0.5 so all corners have the same behavior
        const xRotation = (0.5 - xPercentage) * 20;
        const yRotation = (yPercentage - 0.5) * 20;
        // x needs to rotate vertically so apply yRotation
        // y needs to rotate horizontally so apply xRotation
        event.currentTarget.style.setProperty(
          '--x-rotation',
          `${yRotation}deg`,
        );
        event.currentTarget.style.setProperty(
          '--y-rotation',
          `${xRotation}deg`,
        );
        event.currentTarget.style.setProperty('--x', `${xPercentage * 100}%`);
        event.currentTarget.style.setProperty('--y', `${yPercentage * 100}%`);
      }
    : undefined;

  function handleImageLoad() {
    setImageLoaded(true);
  }

  // Check if image is already complete (for cached images)
  useEffect(() => {
    if (imageRef.current && imageRef.current.complete) {
      setImageLoaded(true);
    }

    // Add a fallback timer for any edge cases
    const timer = setTimeout(() => {
      setImageLoaded(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`w-fit transform-gpu transition-transform duration-200 ease-out [perspective:800px] ${scale === 105 ? 'hover:scale-105' : 'hover:scale-[1.08]'}`}
    >
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        className={perspectiveClasses}
      >
        {src && (
          <img
            ref={imageRef}
            src={`https://image.tmdb.org/t/p/${fetchSize}${src}`}
            srcSet={`https://image.tmdb.org/t/p/w154${src} 154w, https://image.tmdb.org/t/p/w185${src} 185w, https://image.tmdb.org/t/p/w342${src} 342w, https://image.tmdb.org/t/p/w500${src} 500w, https://image.tmdb.org/t/p/w780${src} 780w`}
            sizes={sizes ?? `${width}px`}
            alt={`Poster for ${title}`}
            width={width}
            height={height}
            decoding="async"
            fetchPriority={loading === 'eager' ? 'high' : 'auto'}
            referrerPolicy="no-referrer"
            onLoad={handleImageLoad}
            loading={loading}
            draggable={false}
            className={`${classes} ${imageLoaded ? 'animate-fade-in' : 'opacity-0'} peer relative top-0 rounded object-cover drop-shadow select-none`}
          />
        )}
        {/* the radial gradient is positioned according to mouse position */}
        <div className="pointer-events-none absolute inset-0 rounded drop-shadow group-hover:bg-[radial-gradient(at_var(--x)_var(--y),rgba(255,255,255,0.1)_15%,transparent_70%)]" />
      </div>
    </div>
  );
}
