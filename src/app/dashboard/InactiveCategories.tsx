"use client";

import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Plus } from "lucide-react";
import Card from "@/app/components/Card";
import { categoryStyle } from "@/lib/categoryConstants";
import CategoryIconRender from "@/app/components/CategoryIcon";
import { formatDuration, toDateLocale } from "@/lib/utils";

export interface InactiveCategoryRow {
  id: string;
  name: string;
  color: string;
  icon: string;
  /** Milliseconds since the last wear/session ended. null = never used before. */
  notWornSinceMs: number | null;
  /** When true, links to session-begin instead of wear-begin. */
  isSessionCategory?: boolean;
}

interface Props {
  /** Categories the user defined that currently have no active wear session. */
  categories: InactiveCategoryRow[];
}

/** Always-visible list of inactive wear categories with quick-start link.
 *  Shows time since last session ended ("Pause: Xh Ym"). */
export default function InactiveCategories({ categories }: Props) {
  const t = useTranslations("wearForm");
  const dl = toDateLocale(useLocale());

  if (categories.length === 0) return null;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 pb-2">
      <ul className="flex flex-col gap-2">
        {categories.map((c) => {
          const style = categoryStyle(c.color);
          const beginHref = c.isSessionCategory
            ? `/dashboard/new/session-begin?category=${c.id}`
            : `/dashboard/new/wear-begin?category=${c.id}`;
          const notWornStr = c.notWornSinceMs !== null
            ? formatDuration(new Date(0), new Date(c.notWornSinceMs), dl)
            : null;
          return (
            <li key={c.id}>
              <Card>
                <Link
                  href={beginHref}
                  className="flex items-center gap-3 p-3 active:bg-background-subtle transition opacity-80 hover:opacity-100"
                >
                  <div
                    className="shrink-0 size-9 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: style.backgroundColor, color: style.color }}
                    aria-hidden
                  >
                    <CategoryIconRender name={c.icon} className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                    {notWornStr && (
                      <p className="text-xs text-foreground-faint">
                        {t("notWornSince")} {notWornStr}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-foreground-faint shrink-0 flex items-center gap-1">
                    <Plus size={12} />
                    {c.isSessionCategory ? t("sessionStart") : t("titleBegin")}
                  </span>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
