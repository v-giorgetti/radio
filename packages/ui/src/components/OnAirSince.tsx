export type OnAirSinceProps = {
  /** Start of the current uninterrupted broadcast; null when off air. */
  since: Date | null;
  locale?: string;
};

function formatSince(since: Date, locale?: string) {
  const now = new Date();
  const sameDay = since.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(since);
  if (sameDay) return time;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(since);
  return `${day}, ${time}`;
}

export function OnAirSince({ since, locale }: OnAirSinceProps) {
  return (
    <span className="r-onair r-label" data-state={since ? "live" : "offline"}>
      <span className="r-onair__dot" aria-hidden />
      {since ? (
        <span>
          On air since <time dateTime={since.toISOString()}>{formatSince(since, locale)}</time>
        </span>
      ) : (
        <span>Off air</span>
      )}
    </span>
  );
}
