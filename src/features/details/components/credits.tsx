type CreditsProps = {
  title: string;
  director?: string | false;
  creator?: string | false;
  releaseDate: string | null;
};

export default function Credits({
  title,
  director,
  creator,
  releaseDate,
}: CreditsProps) {
  const roleLabel = director ? 'Directed by ' : creator ? 'Created by ' : '';
  const person = director || creator || '';
  return (
    <>
      <h2 className="font-bespoke text-2xl leading-tight font-bold tracking-tight md:text-4xl md:leading-normal">
        {title}
      </h2>
      <div className="mt-3 text-sm md:mt-2.5 md:text-xl">
        <span className="pr-2 text-sm md:text-base">
          {releaseDate ? releaseDate.slice(0, 4) : ''}
        </span>
        {roleLabel && (
          <span className="tracking-wide md:text-base">
            {roleLabel}
            <span className="font-medium md:inline-block md:text-base">
              {person}
            </span>
          </span>
        )}
      </div>
    </>
  );
}
