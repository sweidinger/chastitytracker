"use client";

import BlockHeading from "@/app/components/BlockHeading";
import Section from "@/app/components/Section";
import { blockInsetCls } from "@/app/components/inputStyles";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Timer, ChevronDown, ChevronUp } from "lucide-react";
import CategoryIconRender from "@/app/components/CategoryIcon";
import CategoryPhotoThumb from "@/app/components/CategoryPhotoThumb";
import { FullscreenImageModal } from "@/app/components/ImageViewer";
import DetailField from "@/app/components/DetailField";
import ListPager from "@/app/components/ListPager";
import usePagedList from "@/app/hooks/usePagedList";
import { BLOCK_PAGE_SIZE } from "@/lib/constants";
import { categoryStyle } from "@/lib/categoryConstants";

import type { WearSessionRow } from "@/lib/wearSessionRows";
export type { WearSessionRow } from "@/lib/wearSessionRows";


/** Read-only list of completed non-KG wear sessions, sorted by start time (newest first). Active
 *  sessions live in ActiveWearSessions at the top of the dashboard — they're filtered out here.
 *
 *  Fork: die Zeilen der aktuellen Seite stehen nach Kategorie gruppiert (Kopfzeile mit Symbol) und
 *  lassen sich aufklappen (Start/Ende/Gerät inline) — wie die KG-Session-Liste. */
export default function WearSessionList({ sessions, defaultCollapsed }: { sessions: WearSessionRow[]; defaultCollapsed?: boolean }) {
  const { page, setPage, totalPages, visible } = usePagedList(sessions, BLOCK_PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);
  // Ein Modal für die ganze Liste statt eines je Zeile — es kann ohnehin nur eines offen sein.
  // Die ganze Zeile im State, weil das Detail-Panel Kategorie, Zeit und Gerät daraus zieht.
  const [openRow, setOpenRow] = useState<WearSessionRow | null>(null);
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");

  if (sessions.length === 0) return null;

  // Die sichtbaren Zeilen nach Kategorie gruppieren (Reihenfolge der ersten Nennung bleibt).
  const groups: { categoryName: string; rows: WearSessionRow[] }[] = [];
  for (const s of visible) {
    const g = groups.find((x) => x.categoryName === s.categoryName);
    if (g) g.rows.push(s);
    else groups.push({ categoryName: s.categoryName, rows: [s] });
  }

  return (
    <Section title={t("otherCategorySessions")} defaultCollapsed={defaultCollapsed}>
      <div className="divide-y divide-border-subtle">
        {groups.map(({ categoryName, rows }) => {
          const first = rows[0];
          const style = categoryStyle(first.categoryColor);
          return (
            <div key={categoryName}>
              <div className={`flex items-center gap-2 ${blockInsetCls} pt-3 pb-1`}>
                <div
                  className="size-4 rounded flex items-center justify-center shrink-0"
                  style={{ backgroundColor: style.backgroundColor, color: style.color }}
                  aria-hidden
                >
                  <CategoryIconRender name={first.categoryIcon} className="size-2.5" />
                </div>
                <BlockHeading as="h3" className="truncate">
                  {categoryName}
                </BlockHeading>
              </div>
              <div className="divide-y divide-border-subtle">
                {rows.map((s) => {
                  const isOpen = openId === s.id;
                  const sameDay = s.startDateStr === s.endDateStr;
                  return (
                    <div key={s.id} className={isOpen ? "bg-surface-raised" : undefined}>
                      <div className={`flex items-center gap-3 ${blockInsetCls} py-3`}>
                        {/* Beim Trage-Beginn aufgenommenes Foto — Klick öffnet es gross. Ohne Foto
                            bleibt das Kategorie-Symbol stehen, als reine Anzeige (kein toter Klick). */}
                        <CategoryPhotoThumb
                          imageUrl={s.imageUrl}
                          categoryColor={s.categoryColor}
                          categoryIcon={s.categoryIcon}
                          size="sm"
                          onClick={s.imageUrl ? () => setOpenRow(s) : undefined}
                          label={s.imageUrl ? t("wearSessionPhotoAlt", { category: s.categoryName }) : undefined}
                        />
                        <button
                          type="button"
                          onClick={() => setOpenId(isOpen ? null : s.id)}
                          aria-expanded={isOpen}
                          className="flex items-center gap-3 flex-1 min-w-0 text-left hover:opacity-80 transition"
                        >
                          <div className="flex-1 min-w-0">
                            {/* Gerätename neben dem Datum: ohne ihn sehen mehrere Sessions derselben
                                Kategorie identisch aus, und gerade dort ist die Frage „welches Gerät
                                war das?" die interessante. */}
                            <p className="text-sm font-semibold text-foreground truncate tabular-nums">
                              {s.startDateStr}
                              {s.deviceName && (
                                <span className="font-normal text-foreground-muted"> · {s.deviceName}</span>
                              )}
                            </p>
                            <p className="text-xs text-foreground-faint tabular-nums truncate">
                              {sameDay
                                ? `${s.startTimeStr} – ${s.endTimeStr}`
                                : `${s.startTimeStr} – ${s.endDateStr}, ${s.endTimeStr}`}
                            </p>
                          </div>
                          <span className="text-neben text-foreground-muted tabular-nums flex items-center gap-1 shrink-0">
                            <Timer size={10} />{s.durationStr}
                          </span>
                          {isOpen
                            ? <ChevronUp size={16} className="text-foreground-faint shrink-0" />
                            : <ChevronDown size={16} className="text-foreground-faint shrink-0" />}
                        </button>
                      </div>

                      {isOpen && (
                        <div className={`${blockInsetCls} pb-4 pt-3 flex flex-col gap-1.5 border-t border-border-subtle`}>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-foreground-faint w-14 shrink-0">{tCommon("start")}</span>
                            <span className="tabular-nums text-foreground-muted">{s.startDateStr}, {s.startTimeStr}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-foreground-faint w-14 shrink-0">{tCommon("end")}</span>
                            <span className="tabular-nums text-foreground-muted">{s.endDateStr}, {s.endTimeStr}</span>
                          </div>
                          {s.deviceName && (
                            <div className="flex items-center gap-3 text-xs">
                              <span className="text-foreground-faint w-14 shrink-0">{tCommon("device")}</span>
                              <span className="text-foreground-muted truncate">{s.deviceName}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <ListPager page={page} totalPages={totalPages} onPage={(p) => { setPage(p); setOpenId(null); }} />

      {openRow?.imageUrl && (
        <FullscreenImageModal
          src={openRow.imageUrl}
          alt={t("wearSessionPhotoAlt", { category: openRow.categoryName })}
          onClose={() => setOpenRow(null)}
          // Kopf + Panel analog zum KG-Foto (SessionEventRow): dort steht die Typ-Pille über
          // Datum/Zeit und Gerät. Hier tritt die Kategorie an die Stelle des Eintragstyps.
          title={
            <span
              className="inline-flex items-center gap-1.5 text-fliess font-semibold text-foreground"
            >
              <CategoryIconRender name={openRow.categoryIcon} className="size-3.5" style={{ color: categoryStyle(openRow.categoryColor).color }} />
              {openRow.categoryName}
            </span>
          }
          panel={
            <div className="flex flex-col gap-3">
              <DetailField label={tCommon("start")}>
                <p className="text-sm font-semibold text-foreground">{openRow.startDateStr}, {openRow.startTimeStr}</p>
              </DetailField>
              <DetailField label={tCommon("end")}>
                <p className="text-sm text-foreground-muted">{openRow.endDateStr}, {openRow.endTimeStr}</p>
              </DetailField>
              {openRow.deviceName && (
                <DetailField label={tCommon("device")}>
                  <p className="text-sm text-foreground-muted">{openRow.deviceName}</p>
                </DetailField>
              )}
              <DetailField label={tCommon("duration")}>
                <p className="text-sm text-foreground-muted">{openRow.durationStr}</p>
              </DetailField>
            </div>
          }
        />
      )}
    </Section>
  );
}
