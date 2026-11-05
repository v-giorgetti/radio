import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentPropsWithoutRef } from "react";
import { cx } from "../cx";

export const TabsRoot = BaseTabs.Root;

export function TabsList({ className, children, ...props }: ComponentPropsWithoutRef<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List className={cx("r-tabs__list", typeof className === "string" && className)} {...props}>
      {children}
      <BaseTabs.Indicator className="r-tabs__indicator" />
    </BaseTabs.List>
  );
}

export function Tab({ className, ...props }: ComponentPropsWithoutRef<typeof BaseTabs.Tab>) {
  return <BaseTabs.Tab className={cx("r-tabs__tab", typeof className === "string" && className)} {...props} />;
}

export function TabsPanel({ className, ...props }: ComponentPropsWithoutRef<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cx("r-tabs__panel", typeof className === "string" && className)} {...props} />;
}
