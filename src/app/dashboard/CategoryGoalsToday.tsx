import { buildCategoryWearGoals, hasAnyGoal } from "@/lib/categoryGoals";
import CategoryGoalsLive from "./CategoryGoalsLive";

interface Props {
  userId: string;
  /** Currently-running wear sessions (already fetched by the dashboard page) — their categories tick
   *  live. Omitted by the admin view, which then shows render-time values without live ticking. */
  activeWearSessions?: { categoryId: string }[];
  /** Kategorien, deren Trainingsvorgaben bereits in einer eigenen Session-Karte gezeigt werden
   *  (z.B. der aktive Plug in LaufendePlugSessionCard) — hier NICHT nochmal rendern (kein Doppel). */
  excludeCategoryIds?: string[];
}

/** Server component — fetches per-category wear hours + goals (tracking-enabled non-KG categories
 *  with at least one period target) and hands them to the live client renderer. Categories with a
 *  running wear session tick up live there. Hidden when no goal data. */
export default async function CategoryGoalsToday({ userId, activeWearSessions = [], excludeCategoryIds = [] }: Props) {
  const now = new Date();
  const allRows = await buildCategoryWearGoals(userId, now);
  const activeCategoryIds = new Set(activeWearSessions.map((s) => s.categoryId));
  const excluded = new Set(excludeCategoryIds);

  const rows = allRows
    .filter(hasAnyGoal)
    .filter((r) => !excluded.has(r.categoryId))
    .map((r) => ({ ...r, active: activeCategoryIds.has(r.categoryId) }));
  if (rows.length === 0) return null;

  return <CategoryGoalsLive rows={rows} serverNow={now.toISOString()} />;
}
