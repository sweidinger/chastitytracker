"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Timer, ChevronDown, ChevronUp } from "lucide-react";
import CategoryIconRender from "@/app/components/CategoryIcon";
import { categoryStyle } from "@/lib/categoryConstants";

import type { WearSessionRow } from "@/lib/utils";
export type { WearSessionRow } from "@/lib/utils";

const PAGE_SIZE = 5;

/** Read-only list of completed non-KG wear sessions.
 *  Grouped by category with expandable rows — same visual style as KG SessionListClient.
 *  Active sessions live in ActiveWearSessions at the top of the dashboard. */
export default function WearSessionList({ sessions }: { sessions: WearSessionRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const tCommon = useTranslations("common");

  if (sessions.length === 0) return null;

  const totalPages = Math.ceil(sessions.length / PAGE_SIZE);
  const paginated = sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Group paginated sessions by category (preserving order)
  const catOrder: string[] = [];
  const byCategory = new Map<string, WearSessionRow[]>();
  for (const s of paginated) {
    if (!byCategory.has(s.categoryName)) {
      catOrder.push(s.categoryName);
      byCategory.set(s.categoryName, []);
    }
    byCategory.get(s.categoryName)!.push(s);
  }

  return (
    <>
      {catOrder.map((catName) => {
        const catSessions = byCategory.get(catName)!;
        const first = catSessions[0];
        const style = categoryStyle(first.categoryColor);

        return (
          <div key={catName} className="bg-surface rounded-2xl border border-border overflow-hidden">
            {/* Section header with category icon — mirrors "KG-SESSIONS" */}
            <div className="px-5 py-3 border-b border-border-subtle flex items-center gap-2">
              <div
                className="size-4 rounded flex items-center justify-center shrink-0"
                style={{ backgroundColor: style.backgroundColor, color: style.color }}
                aria-hidden
              >
                <CategoryIconRender name={first.categoryIcon} className="size-2.5" />
              </div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">
                {catName}
              </p>
            </div>

            <div className="divide-y divide-border-subtle">
              {catSessions.map((s) => {
                const isOpen = openId === s.id;
                const sameDay = s.startDateStr === s.endDateStr;

                return (
                  <div key={s.id} className={isOpen ? "bg-surface-raised" : undefined}>
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : s.id)}
                      className="w-full flex items-center gap-3 px-5 py-3 hover:bg-surface-raised transition text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-foreground tabular-nums">
                          {s.startDateStr}
                        </span>
                        <span className="block text-xs text-foreground-faint tabular-nums">
                          {sameDay
                            ? `${s.startTimeStr} – ${s.endTimeStr}`
                            : `${s.startTimeStr} – ${s.endDateStr}, ${s.endTimeStr}`}
                        </span>
                      </div>
                      <span className="text-xs font-mono text-foreground-muted bg-surface-raised border border-border px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
                        <Timer size={10} />{s.durationStr}
                      </span>
                      {isOpen
                        ? <ChevronUp size={16} className="text-foreground-faint shrink-0" />
                        : <ChevronDown size={16} className="text-foreground-faint shrink-0" />}
                    </button>

                    {isOpen && (
                      <div className="px-5 pb-4 flex flex-col gap-1.5 border-t border-border-subtle pt-3">
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-foreground-faint w-10 shrink-0">{tCommon("start")}</span>
                          <span className="tabular-nums text-foreground-muted">{s.startDateStr}, {s.startTimeStr}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-foreground-faint w-10 shrink-0">{tCommon("end")}</span>
                          <span className="tabular-nums text-foreground-muted">{s.endDateStr}, {s.endTimeStr}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {totalPages > 1 && (
        <div className="bg-surface rounded-2xl border border-border flex items-center justify-between px-5 py-3">
          <button
            type="button"
            onClick={() => { setPage((p) => p - 1); setOpenId(null); }}
            disabled={page === 0}
            className="text-xs font-medium text-foreground-muted disabled:text-foreground-faint hover:text-foreground transition"
          >
            ← {tCommon("previous")}
          </button>
          <span className="text-xs text-foreground-faint tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => { setPage((p) => p + 1); setOpenId(null); }}
            disabled={page >= totalPages - 1}
            className="text-xs font-medium text-foreground-muted disabled:text-foreground-faint hover:text-foreground transition"
          >
            {tCommon("next")} →
          </button>
        </div>
      )}
    </>
  );
}
