import { ListenersIcon } from "../icons";
import { AnimatedNumber } from "./AnimatedNumber";

export type ListenerCountProps = {
  count: number;
  locale?: string;
};

export function ListenerCount({ count, locale }: ListenerCountProps) {
  return (
    <span className="r-listeners r-label" title="Active audio connections">
      <ListenersIcon />
      <AnimatedNumber value={count} locale={locale} />
      <span>{count === 1 ? "listener" : "listeners"}</span>
    </span>
  );
}
